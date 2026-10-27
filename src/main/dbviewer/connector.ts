import { existsSync, statSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import type { DbEngine, DvAws, DvMethod, DvOptions, DvSsh, DvVault } from '@shared/types';
import { DV_DEFAULT_OPTIONS } from '@shared/types';
import { connect, type ConnectSettings, type Driver } from './driver';
import { awsCredentials, openTunnel, rdsAuthToken, rdsCa, regionOf, vaultCredentials, type Tunnel } from './remote';
import { words } from '@shared/platform';

/**
 * Opens one connection step by step — Vault credentials, AWS IAM token, SSH
 * tunnel, reaching the server, signing in — reporting each step, stoppable
 * with an AbortSignal, and turning driver errors into readable messages.
 */

export interface Plan {
  engine: DbEngine;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  file: string;
  method: DvMethod;
  socket: string;
  ssh: DvSsh | null;
  aws: DvAws | null;
  vault: DvVault | null;
  options: DvOptions;
  sshSecret: string;
  awsSecret: string;
  vaultToken: string;
}

export interface Opened {
  driver: Driver;
  tunnel: Tunnel | null;
  version: string;
  user: string;
  /** AWS IAM tokens expire: the driver is reopened after this (ms epoch). */
  renewAt: number | null;
}

export type Report = (steps: string[], step: number, detail: string) => void;

const where = (p: Plan) => (p.method === 'socket' ? p.socket : `${p.host}:${p.port}`);

/** The steps a plan goes through (shown before they run). */
export function stepsOf(p: Plan): string[] {
  if (p.engine === 'sqlite') return ['Opening the database file'];
  const s: string[] = [];
  if (p.method === 'vault') s.push('Reading credentials from Vault');
  if (p.method === 'aws-iam') s.push('Creating an AWS IAM auth token');
  if (p.method === 'ssh' && p.ssh) s.push(`Opening an SSH tunnel through ${p.ssh.user}@${p.ssh.host}`);
  s.push(p.method === 'socket' ? `Reaching ${p.socket}` : p.method === 'ssh' ? `Reaching ${p.host}:${p.port} through the tunnel` : `Reaching ${p.host}:${p.port}`);
  s.push(p.options.requireSsl || p.method === 'aws-iam' ? 'Signing in over SSL' : 'Signing in');
  return s;
}

/** A TCP connect (or the socket file) with the plan's timeout: tells "can't reach" apart from "can't sign in". */
function reach(host: string, port: number, ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = netConnect({ host, port });
    const done = (e?: Error) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      sock.destroy();
      e ? reject(e) : resolve();
    };
    const onAbort = () => done(new Error('Cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => done(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), ms);
    sock.once('connect', () => done());
    sock.once('error', (e) => done(e));
  });
}

/** Races a promise with the signal. */
function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('Cancelled'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error('Cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

export async function establish(plan: Plan, report: Report, signal: AbortSignal): Promise<Opened> {
  const steps = stepsOf(plan);
  let i = 0;
  const next = (detail = '') => report(steps, i++, detail);
  const o = { ...DV_DEFAULT_OPTIONS, ...plan.options };
  const ms = Math.max(3, o.connectTimeout) * 1000;
  let tunnel: Tunnel | null = null;
  let driver: Driver | null = null;
  try {
    if (plan.engine === 'sqlite') {
      next(plan.file);
      if (!existsSync(plan.file)) throw new Error(`${plan.file} does not exist`);
      driver = connect({ engine: 'sqlite', host: '', port: 0, user: '', password: '', database: '', file: plan.file });
      const version = await driver.version();
      return { driver, tunnel: null, version, user: '', renewAt: null };
    }

    let user = plan.user;
    let password: string = plan.password;
    let ca: string | undefined;
    let renewAt: number | null = null;
    const settings: Partial<ConnectSettings> = {};

    if (plan.method === 'vault') {
      next(plan.vault?.path ?? '');
      if (!plan.vault) throw new Error('Vault settings are missing');
      const c = await vaultCredentials(plan.vault, plan.vaultToken, ms, signal);
      user = c.user;
      password = c.password;
    }
    if (plan.method === 'aws-iam') {
      next('');
      if (!plan.aws) throw new Error('AWS settings are missing');
      const creds = awsCredentials(plan.aws, plan.awsSecret);
      const region = plan.aws.region || regionOf(plan.host) || creds.region || process.env.AWS_REGION || '';
      if (!region) throw new Error('AWS region unknown: enter it (e.g. ap-southeast-1)');
      if (!user) throw new Error('Enter the database user that has IAM authentication (rds_iam / GRANT AWSAuthenticationPlugin)');
      password = rdsAuthToken(plan.host, plan.port, user, region, creds);
      renewAt = Date.now() + 10 * 60_000;
      report(steps, i - 1, `${region} · token for ${user}; fetching the Amazon RDS certificates`);
      ca = await rdsCa(signal);
      o.requireSsl = true;
      o.verifyCert = true;
      if (plan.engine === 'mysql' || plan.engine === 'mariadb') o.cleartext = true;
    }
    let host = plan.host;
    let port = plan.port;
    if (plan.method === 'ssh') {
      next(plan.ssh ? `${plan.ssh.host}:${plan.ssh.port || 22} as ${plan.ssh.user} (${plan.ssh.auth})` : '');
      if (!plan.ssh?.host || !plan.ssh.user) throw new Error('SSH host and user are needed');
      tunnel = await openTunnel(plan.ssh, plan.sshSecret, plan.host || '127.0.0.1', plan.port, ms, signal);
      settings.servername = plan.host;
      host = '127.0.0.1';
      port = tunnel.port;
    }

    // Reach the server.
    next(plan.method === 'ssh' ? `local port ${port}` : '');
    if (plan.method === 'socket') {
      if (!plan.socket) throw new Error('Enter the socket path');
      const sockPath = plan.engine === 'postgresql' && existsSync(plan.socket) && statSync(plan.socket).isDirectory() ? `${plan.socket.replace(/\/$/, '')}/.s.PGSQL.${plan.port}` : plan.socket;
      if (!existsSync(sockPath)) throw new Error(`No socket at ${sockPath} (is the server running, and is this its socket?)`);
    } else if (!(plan.engine === 'mongodb' && o.srv)) {
      await reach(host, port, ms, signal);
    }

    // Sign in.
    next(o.requireSsl ? (o.verifyCert ? 'certificate checked' : 'certificate not checked') : '');
    driver = connect({ engine: plan.engine, host, port, user, password, database: plan.database, file: '', socket: plan.method === 'socket' ? plan.socket : undefined, options: o, ca, ...settings });
    const version = await abortable(driver.version(), signal);
    return { driver, tunnel, version, user, renewAt };
  } catch (e) {
    void driver?.close().catch(() => undefined);
    tunnel?.close();
    if (signal.aborted) throw new Error('Cancelled');
    throw new Error(friendly(e as Error & { code?: string; errno?: number }, plan));
  }
}

/** Driver / socket errors → what to check. */
export function friendly(e: Error & { code?: string; errno?: number; sqlMessage?: string }, p: Plan): string {
  const code = e.code ?? '';
  const msg = e.sqlMessage ?? e.message ?? String(e);
  const at = where(p);
  if (msg === 'Cancelled') return msg;
  if (/^(SSH|Vault|AWS|Amazon RDS|No socket|Enter|The server wants)/.test(msg)) return msg;
  if (code === 'ECONNREFUSED') return `Nothing accepts connections at ${at} (connection refused). Is the server running and listening on that address?`;
  if (code === 'ETIMEDOUT' || /timeout|timed out|did not answer/i.test(msg))
    return `No answer from ${at} within ${p.options.connectTimeout} s. A firewall, security group or VPN may block it${p.method === 'tcp' ? '; production servers are often only reachable through SSH' : ''}.`;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `The host ${p.host} cannot be found (DNS). Check the name, or connect to the VPN it lives on.`;
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return `${at} is not reachable from ${words.thisComputer} (no route). Check the VPN or network.`;
  if (code === 'ECONNRESET' || code === 'PROTOCOL_CONNECTION_LOST') return `${at} closed the connection${p.options.requireSsl ? ' (the server may not accept SSL here)' : ' (the server may require SSL: turn on "Require SSL")'}.`;
  if (code === 'ER_ACCESS_DENIED_ERROR' || code === '28P01' || /authentication failed|Access denied|WRONGPASS|invalid password|NOAUTH|Authentication failed/i.test(msg))
    return `${p.method === 'aws-iam' ? 'AWS IAM sign-in refused (is IAM auth enabled on the instance, and does the user have rds_iam / AWSAuthenticationPlugin and an rds-db:connect policy?)' : 'Wrong user or password'}: ${msg}`;
  if (code === 'ER_BAD_DB_ERROR' || code === '3D000') return `The database ${p.database} does not exist on the server: ${msg}`;
  if (/self[- ]signed|unable to verify|UNABLE_TO_GET_ISSUER|CERT_|certificate/i.test(msg) || /^(DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|ERR_TLS_CERT_ALTNAME_INVALID)$/.test(code))
    return `The server's SSL certificate could not be verified (${msg}). For a self-signed certificate turn off "Verify certificate".`;
  if (/does not support SSL|server does not support secure|SSL connection is required|requires SSL|no pg_hba.conf entry.*SSL off|insecure transport/i.test(msg))
    return `${msg}. Turn ${/does not support/i.test(msg) ? 'off' : 'on'} "Require SSL".`;
  if (/mysql_clear_password|cleartext/i.test(msg)) return `${msg}. The server asks for the cleartext plugin: turn on "Enable Cleartext plugin" (only over SSL).`;
  if (/pg_hba\.conf/.test(msg)) return `The server does not allow this client: ${msg}`;
  return msg;
}
