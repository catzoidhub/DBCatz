import { createHash, createHmac } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type Socket } from 'node:net';
import { Client, type ConnectConfig } from 'ssh2';
import type { DvAws, DvSsh, DvVault } from '@shared/types';
import { dataDir } from '../store';

/**
 * How DBCatz reaches production servers: an SSH tunnel (ssh2, a local port
 * forwarded through the SSH host), an AWS IAM auth token for RDS (SigV4
 * presigned, 15 minutes), the Amazon RDS CA bundle, and database credentials
 * read from HashiCorp Vault. Every step takes an AbortSignal.
 */

const expand = (p: string) => (p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

// ---------------------------------------------------------------- SSH

export interface Tunnel {
  /** 127.0.0.1:<port> forwards to the database through the SSH host. */
  port: number;
  close(): void;
}

/** Opens an SSH connection and a local listener forwarding to `dstHost:dstPort` seen from the SSH host. */
export function openTunnel(ssh: DvSsh, secret: string, dstHost: string, dstPort: number, timeoutMs: number, signal: AbortSignal): Promise<Tunnel> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let server: Server | null = null;
    let settled = false;
    const sockets = new Set<Socket>();
    const close = () => {
      for (const s of sockets) s.destroy();
      server?.close();
      client.end();
    };
    const fail = (e: Error) => {
      if (settled) return;
      settled = true;
      close();
      reject(e);
    };
    const onAbort = () => fail(new Error('Cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });

    const cfg: ConnectConfig = { host: ssh.host, port: ssh.port || 22, username: ssh.user, readyTimeout: timeoutMs, keepaliveInterval: 15_000 };
    if (ssh.auth === 'password') cfg.password = secret;
    else if (ssh.auth === 'agent') {
      cfg.agent = process.env.SSH_AUTH_SOCK;
      if (!cfg.agent) return fail(new Error('SSH agent: SSH_AUTH_SOCK is not set (start ssh-agent and add your key), or choose a key file'));
    } else {
      const path = expand(ssh.keyPath);
      if (!path || !existsSync(path)) return fail(new Error(`SSH key ${ssh.keyPath || '(none)'} not found`));
      cfg.privateKey = readFileSync(path);
      if (secret) cfg.passphrase = secret;
    }
    client.on('error', (e: Error & { level?: string }) => {
      const msg = e.level === 'client-authentication' ? `SSH: ${ssh.user}@${ssh.host} refused the ${ssh.auth === 'key' ? 'key' : ssh.auth} (authentication failed)` : /Encrypted private OpenSSH key|passphrase/i.test(e.message) ? 'SSH: the key needs its passphrase' : `SSH: ${e.message}`;
      fail(new Error(msg));
    });
    client.on('ready', () => {
      server = createServer((sock) => {
        sockets.add(sock);
        sock.on('close', () => sockets.delete(sock));
        client.forwardOut('127.0.0.1', 0, dstHost, dstPort, (err, stream) => {
          if (err) return sock.destroy();
          sock.pipe(stream).pipe(sock);
          stream.on('close', () => sock.destroy());
          sock.on('error', () => stream.close());
        });
      });
      server.on('error', (e) => fail(e));
      server.listen(0, '127.0.0.1', () => {
        // Check the far end once: a tunnel to a closed port should fail here, not later.
        client.forwardOut('127.0.0.1', 0, dstHost, dstPort, (err, stream) => {
          if (err) return fail(new Error(`SSH: ${ssh.host} cannot reach ${dstHost}:${dstPort}${/open failure:?\s*$/i.test(err.message) ? ' (nothing listens there, or the SSH server forbids forwarding)' : ` (${err.message.replace(/^\(SSH\)\s*/, '')})`}`));
          stream.close();
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', onAbort);
          resolve({ port: (server!.address() as { port: number }).port, close });
        });
      });
    });
    client.on('close', () => {
      if (!settled) fail(new Error(`SSH: ${ssh.host} closed the connection`));
    });
    try {
      client.connect(cfg);
    } catch (e) {
      fail(new Error(`SSH: ${(e as Error).message}`));
    }
  });
}

/** Private keys in ~/.ssh (files with a matching .pub, or id_*). */
export function sshKeys(): string[] {
  const dir = join(homedir(), '.ssh');
  try {
    const files = readdirSync(dir);
    return files.filter((f) => !f.endsWith('.pub') && (files.includes(`${f}.pub`) || /^id_/.test(f)) && !/^(known_hosts|config|authorized_keys)/.test(f)).map((f) => `~/.ssh/${f}`);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- AWS IAM

interface AwsCreds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

function ini(path: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  if (!existsSync(path)) return out;
  let cur = '';
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) {
      cur = sec[1].trim().replace(/^profile\s+/, '');
      out[cur] ??= {};
      continue;
    }
    const kv = /^([^=]+)=(.*)$/.exec(line);
    if (kv && cur) out[cur][kv[1].trim()] = kv[2].trim();
  }
  return out;
}

export function awsProfiles(): string[] {
  const names = new Set([...Object.keys(ini(join(homedir(), '.aws', 'credentials'))), ...Object.keys(ini(join(homedir(), '.aws', 'config')))]);
  return [...names].sort((a, b) => (a === 'default' ? -1 : b === 'default' ? 1 : a.localeCompare(b)));
}

/** Credentials: the key in the connection, else the profile, else the environment. */
export function awsCredentials(aws: DvAws, secret: string): AwsCreds & { region?: string } {
  if (aws.accessKeyId && secret) return { accessKeyId: aws.accessKeyId, secretAccessKey: secret };
  const profile = aws.profile || process.env.AWS_PROFILE || 'default';
  const creds = ini(join(homedir(), '.aws', 'credentials'))[profile] ?? {};
  const conf = ini(join(homedir(), '.aws', 'config'))[profile] ?? {};
  const merged = { ...conf, ...creds };
  if (merged.aws_access_key_id && merged.aws_secret_access_key) return { accessKeyId: merged.aws_access_key_id, secretAccessKey: merged.aws_secret_access_key, sessionToken: merged.aws_session_token, region: merged.region };
  if (merged.sso_session || merged.sso_start_url || merged.credential_process || merged.role_arn)
    throw new Error(`AWS profile ${profile} uses SSO / a role / credential_process: run "aws configure export-credentials --profile ${profile}" style tools are not read here; use an access key or a profile with static keys`);
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) return { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY, sessionToken: process.env.AWS_SESSION_TOKEN };
  throw new Error(aws.profile ? `AWS profile ${aws.profile} has no access key in ~/.aws/credentials` : 'No AWS credentials: enter an access key, or pick a profile from ~/.aws');
}

/** mydb.abc123.eu-west-1.rds.amazonaws.com → eu-west-1. */
export const regionOf = (host: string) => /\.([a-z]{2}(?:-gov)?-[a-z]+-\d)\.rds\.amazonaws\.com(?:\.cn)?$/i.exec(host)?.[1] ?? '';

const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();
const sha256hex = (data: string) => createHash('sha256').update(data).digest('hex');

/** The RDS IAM auth token (a SigV4-presigned "connect" URL without the scheme), valid 15 minutes. */
export function rdsAuthToken(host: string, port: number, user: string, region: string, c: AwsCreds, now = new Date()): string {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${region}/rds-db/aws4_request`;
  const q: Record<string, string> = {
    Action: 'connect',
    DBUser: user,
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${c.accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': '900',
    ...(c.sessionToken ? { 'X-Amz-Security-Token': c.sessionToken } : {}),
    'X-Amz-SignedHeaders': 'host',
  };
  const enc = (v: string) => encodeURIComponent(v).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  const query = Object.keys(q)
    .sort()
    .map((k) => `${enc(k)}=${enc(q[k])}`)
    .join('&');
  const hostHeader = `${host}:${port}`;
  const canonical = ['GET', '/', query, `host:${hostHeader}\n`, 'host', sha256hex('')].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${c.secretAccessKey}`, date), region), 'rds-db'), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(toSign).digest('hex');
  // Same order as AWS's own signer (the signature sorted in with the rest).
  const all = { ...q, 'X-Amz-Signature': signature } as Record<string, string>;
  return `${hostHeader}/?${Object.keys(all)
    .sort()
    .map((k) => `${enc(k)}=${enc(all[k])}`)
    .join('&')}`;
}

/** Amazon RDS CA bundle (all regions), downloaded once and kept. */
export async function rdsCa(signal: AbortSignal): Promise<string> {
  const file = join(dataDir('dbviewer'), 'rds-global-bundle.pem');
  if (existsSync(file)) return readFileSync(file, 'utf8');
  const r = await fetch('https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem', { signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) });
  if (!r.ok) throw new Error(`Amazon RDS certificates: HTTP ${r.status}`);
  const pem = await r.text();
  if (!pem.includes('BEGIN CERTIFICATE')) throw new Error('Amazon RDS certificates: unexpected download');
  writeFileSync(file, pem);
  return pem;
}

// ---------------------------------------------------------------- Vault

/** Username and password from Vault: a database secrets engine (data.username) or KV v2 (data.data.username). */
export async function vaultCredentials(v: DvVault, token: string, timeoutMs: number, signal: AbortSignal): Promise<{ user: string; password: string; lease: string | null }> {
  if (!v.addr.trim()) throw new Error('Vault: the address is empty');
  if (!v.path.trim()) throw new Error('Vault: the secret path is empty');
  if (!token) throw new Error('Vault: no token');
  const url = `${v.addr.trim().replace(/\/+$/, '')}/v1/${v.path.trim().replace(/^\/+/, '').replace(/^v1\//, '')}`;
  let r: Response;
  try {
    r = await fetch(url, { headers: { 'X-Vault-Token': token, ...(v.namespace ? { 'X-Vault-Namespace': v.namespace } : {}) }, signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) });
  } catch (e) {
    if (signal.aborted) throw new Error('Cancelled');
    throw new Error(`Vault: ${(e as Error).cause ? String(((e as Error).cause as Error).message ?? (e as Error).cause) : (e as Error).message}`);
  }
  const body = (await r.json().catch(() => null)) as { data?: Record<string, unknown> & { data?: Record<string, unknown> }; errors?: string[]; lease_id?: string } | null;
  if (!r.ok) throw new Error(`Vault ${r.status}: ${body?.errors?.join('; ') || r.statusText}${r.status === 403 ? ' (token expired or no policy for this path?)' : ''}`);
  const data = (body?.data?.data ?? body?.data ?? {}) as Record<string, unknown>;
  const user = String(data.username ?? data.user ?? data.DB_USERNAME ?? '');
  const password = String(data.password ?? data.pass ?? data.DB_PASSWORD ?? '');
  if (!user || !password) throw new Error(`Vault: ${v.path} has no username / password fields (found: ${Object.keys(data).join(', ') || 'nothing'})`);
  return { user, password, lease: body?.lease_id || null };
}
