import type { DbEngine } from '@shared/types';

/**
 * Column types as choices: a base type per engine with the parameters it
 * takes (length, precision / scale, enum values), composed into / parsed from
 * the type string the server understands. Also what editor a grid cell gets.
 */

export type Param = 'length' | 'precision' | 'values';

export interface BaseType {
  name: string;
  group: 'Numbers' | 'Text' | 'Date & time' | 'Boolean' | 'JSON & binary' | 'Other';
  params?: Param[];
  /** Default length / precision shown when picked. */
  length?: number;
  scale?: number;
}

const N = (name: string, extra: Partial<BaseType> = {}): BaseType => ({ name, group: 'Numbers', ...extra });
const T = (name: string, extra: Partial<BaseType> = {}): BaseType => ({ name, group: 'Text', ...extra });
const D = (name: string): BaseType => ({ name, group: 'Date & time' });
const B = (name: string): BaseType => ({ name, group: 'Boolean' });
const J = (name: string): BaseType => ({ name, group: 'JSON & binary' });
const O = (name: string, extra: Partial<BaseType> = {}): BaseType => ({ name, group: 'Other', ...extra });

const MYSQL: BaseType[] = [
  N('INT'), N('BIGINT'), N('SMALLINT'), N('TINYINT'), N('MEDIUMINT'), N('DECIMAL', { params: ['precision'], length: 10, scale: 2 }), N('FLOAT'), N('DOUBLE'),
  T('VARCHAR', { params: ['length'], length: 255 }), T('CHAR', { params: ['length'], length: 36 }), T('TEXT'), T('TINYTEXT'), T('MEDIUMTEXT'), T('LONGTEXT'),
  D('DATE'), D('DATETIME'), D('TIMESTAMP'), D('TIME'), D('YEAR'),
  B('BOOLEAN'),
  J('JSON'), J('BLOB'), J('MEDIUMBLOB'), J('LONGBLOB'), J('VARBINARY'),
  O('ENUM', { params: ['values'] }), O('SET', { params: ['values'] }),
];
const MARIADB: BaseType[] = [...MYSQL.slice(0, MYSQL.length - 2), O('UUID'), O('INET6'), O('ENUM', { params: ['values'] }), O('SET', { params: ['values'] })];
const PG: BaseType[] = [
  N('integer'), N('bigint'), N('smallint'), N('numeric', { params: ['precision'], length: 10, scale: 2 }), N('real'), N('double precision'), N('serial'), N('bigserial'),
  T('varchar', { params: ['length'], length: 255 }), T('char', { params: ['length'], length: 36 }), T('text'),
  D('date'), D('timestamp'), D('timestamptz'), D('time'), D('timetz'), D('interval'),
  B('boolean'),
  J('json'), J('jsonb'), J('bytea'),
  O('uuid'), O('inet'), O('cidr'), O('macaddr'), O('money'), O('xml'), O('text[]'), O('integer[]'),
];
const SQLITE: BaseType[] = [N('INTEGER'), N('REAL'), N('NUMERIC'), T('TEXT'), J('BLOB')];
const ES: BaseType[] = [T('keyword'), T('text'), N('integer'), N('long'), N('short'), N('byte'), N('float'), N('double'), N('scaled_float'), B('boolean'), D('date'), D('date_nanos'), J('binary'), O('object'), O('nested'), O('geo_point'), O('geo_shape'), O('ip'), O('completion')];

export const BASE_TYPES: Record<DbEngine, BaseType[]> = { mysql: MYSQL, mariadb: MARIADB, postgresql: PG, sqlite: SQLITE, elasticsearch: ES, mongodb: [], redis: [], valkey: [] };

export interface TypeChoice {
  base: string;
  length: number | null;
  scale: number | null;
  values: string[];
  /** Anything after the parameters (UNSIGNED, [] …), kept when editing. */
  suffix: string;
}

/** `varchar(255)`, `decimal(10,2)`, `enum('a','b')`, `int unsigned` → parts. */
export function parseType(engine: DbEngine, type: string): TypeChoice {
  const t = type.trim();
  const open = t.indexOf('(');
  const close = open >= 0 ? t.indexOf(')', open) : -1;
  let head = (open >= 0 ? t.slice(0, open) : t).trim();
  const inner = open >= 0 && close > open ? t.slice(open + 1, close).trim() : '';
  let suffix = (close >= 0 ? t.slice(close + 1) : '').trim();
  // PostgreSQL spells some types out.
  if (engine === 'postgresql') head = { 'character varying': 'varchar', character: 'char', 'timestamp without time zone': 'timestamp', 'timestamp with time zone': 'timestamptz', 'time without time zone': 'time', 'time with time zone': 'timetz' }[head.toLowerCase()] ?? head;
  // The longest known type the head starts with (`double precision`, `int unsigned` → int + unsigned).
  const words = head.split(/\s+/);
  let base = head;
  let known: BaseType | undefined;
  for (let k = words.length; k > 0 && !known; k--) {
    const cand = words.slice(0, k).join(' ');
    known = BASE_TYPES[engine].find((b) => b.name.toLowerCase() === cand.toLowerCase());
    if (known) {
      base = known.name;
      suffix = [words.slice(k).join(' '), suffix].filter(Boolean).join(' ');
    }
  }
  if (!known && words.length > 1) {
    base = words[0];
    suffix = [words.slice(1).join(' '), suffix].filter(Boolean).join(' ');
  }
  const params = known?.params ?? [];
  if (params.includes('values') || /^(enum|set)$/i.test(base)) return { base, length: null, scale: null, values: inner ? inner.split(/,(?=(?:[^']*'[^']*')*[^']*$)/).map((v) => v.trim().replace(/^'|'$/g, '').replace(/''/g, "'")) : [], suffix };
  const nums = inner ? inner.split(',').map((x) => Number(x.trim())) : [];
  return { base, length: Number.isFinite(nums[0]) ? nums[0] : null, scale: Number.isFinite(nums[1]) ? nums[1] : null, values: [], suffix };
}

export function composeType(engine: DbEngine, c: TypeChoice): string {
  const known = BASE_TYPES[engine].find((b) => b.name.toLowerCase() === c.base.toLowerCase());
  const params = known?.params ?? (/^(enum|set)$/i.test(c.base) ? ['values'] : []);
  let t = c.base;
  if (params.includes('values')) t += `(${c.values.map((v) => `'${v.replace(/'/g, "''")}'`).join(',')})`;
  else if (params.includes('precision')) t += c.length !== null ? `(${c.length}${c.scale !== null ? `,${c.scale}` : ''})` : '';
  else if (params.includes('length')) t += c.length !== null ? `(${c.length})` : '';
  else if (c.length !== null && !known) t += `(${c.length}${c.scale !== null ? `,${c.scale}` : ''})`;
  return c.suffix ? `${t} ${c.suffix}` : t;
}

export type EditorKind = 'text' | 'textarea' | 'number' | 'bool' | 'enum' | 'set' | 'date' | 'datetime' | 'time' | 'json';

/** Which editor a value of this column type gets (engine-agnostic names). */
export function editorFor(type: string): { kind: EditorKind; options: string[] } {
  const t = type.toLowerCase().trim();
  const inner = /\(([^)]*)\)/.exec(t)?.[1] ?? '';
  const values = () => inner.split(/,(?=(?:[^']*'[^']*')*[^']*$)/).map((v) => v.trim().replace(/^'|'$/g, '').replace(/''/g, "'")).filter(Boolean);
  if (/^enum\b/.test(t)) return { kind: 'enum', options: values() };
  if (/^set\b/.test(t)) return { kind: 'set', options: values() };
  if (/^(bool|boolean|bit\(1\)|tinyint\(1\))/.test(t)) return { kind: 'bool', options: [] };
  if (/^(datetime|timestamp)/.test(t)) return { kind: 'datetime', options: [] };
  if (/^date\b/.test(t)) return { kind: 'date', options: [] };
  if (/^time\b/.test(t)) return { kind: 'time', options: [] };
  if (/^(json|jsonb)\b/.test(t) || t === 'object' || t === 'array') return { kind: 'json', options: [] };
  if (/^(int|integer|bigint|smallint|tinyint|mediumint|decimal|numeric|float|double|real|serial|bigserial|long|short|number|money)\b/.test(t)) return { kind: 'number', options: [] };
  if (/^(text|tinytext|mediumtext|longtext|clob|blob|bytea)\b/.test(t)) return { kind: 'textarea', options: [] };
  return { kind: 'text', options: [] };
}
