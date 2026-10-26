/**
 * Small tokenizers for the DBCatz editors: SQL, redis-cli lines, mongosh-like
 * calls, Kibana-console requests and JSON. Each returns HTML with one <span>
 * per token (classes `hl-*`, colours in main.css); plain text is escaped.
 */

export type Language = 'sql' | 'redis' | 'mongo' | 'es' | 'json';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const span = (cls: string, s: string) => (cls ? `<span class="hl-${cls}">${esc(s)}</span>` : esc(s));

const SQL_KEYWORDS = new Set(
  'SELECT FROM WHERE AND OR NOT IN IS NULL LIKE ILIKE BETWEEN EXISTS AS ON JOIN LEFT RIGHT INNER OUTER FULL CROSS NATURAL USING GROUP BY HAVING ORDER ASC DESC LIMIT OFFSET UNION ALL DISTINCT INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE VIEW INDEX UNIQUE PRIMARY KEY FOREIGN REFERENCES DROP ALTER ADD COLUMN RENAME TO MODIFY CHANGE TRUNCATE DATABASE SCHEMA IF DEFAULT CONSTRAINT CHECK CASCADE RESTRICT WITH RECURSIVE CASE WHEN THEN ELSE END BEGIN COMMIT ROLLBACK TRANSACTION EXPLAIN ANALYZE SHOW DESCRIBE USE GRANT REVOKE RETURNING CONFLICT DO NOTHING REPLACE ENGINE CHARSET COLLATE AUTO_INCREMENT AUTOINCREMENT UNSIGNED TEMPORARY OVER PARTITION WINDOW FETCH NEXT ROWS ONLY TOP PRAGMA VACUUM'.split(' '),
);
const SQL_TYPES = new Set(
  'INT INTEGER BIGINT SMALLINT TINYINT MEDIUMINT DECIMAL NUMERIC FLOAT DOUBLE REAL BOOLEAN BOOL VARCHAR CHAR TEXT TINYTEXT MEDIUMTEXT LONGTEXT BLOB JSON JSONB DATE DATETIME TIMESTAMP TIMESTAMPTZ TIME YEAR ENUM UUID SERIAL BIGSERIAL BYTEA INET INTERVAL VARBINARY BINARY BIT MONEY XML ARRAY'.split(' '),
);
const SQL_FUNCTIONS = new Set(
  'COUNT SUM AVG MIN MAX COALESCE NULLIF IFNULL NOW CURRENT_TIMESTAMP CURRENT_DATE DATE_FORMAT CONCAT LOWER UPPER LENGTH SUBSTRING SUBSTR TRIM ROUND FLOOR CEIL ABS CAST CONVERT GROUP_CONCAT STRING_AGG ARRAY_AGG JSON_EXTRACT JSON_AGG ROW_NUMBER RANK DENSE_RANK LAG LEAD IF GREATEST LEAST REPLACE DATE YEAR MONTH DAY HOUR MINUTE EXTRACT DATE_ADD DATE_SUB DATEDIFF RANDOM RAND LAST_INSERT_ID VERSION DATABASE GEN_RANDOM_UUID'.split(' '),
);

/** SQL: comments, strings, numbers, keywords, types, functions, quoted / known identifiers, operators. */
export function highlightSql(src: string, names: Set<string> = new Set()): string {
  const re = /(--[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)|('(?:[^'\\]|\\.|'')*'?)|("(?:[^"\\]|\\.)*"?|`[^`]*`?)|(\b\d+(?:\.\d+)?\b)|(\b[A-Za-z_][A-Za-z0-9_]*\b)|([<>=!+\-*/%|&^~]+|::)|([(),;.])/g;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    out += esc(src.slice(last, m.index));
    last = re.lastIndex;
    const [tok, cmt, sq, dq, num, word, op, punct] = m;
    if (cmt) out += span('cmt', tok);
    else if (sq) out += span('str', tok);
    else if (dq) out += span('ident', tok);
    else if (num) out += span('num', tok);
    else if (word) {
      const u = word.toUpperCase();
      const nextParen = /^\s*\(/.test(src.slice(last));
      if (SQL_KEYWORDS.has(u)) out += span('kw', tok);
      else if (SQL_TYPES.has(u)) out += span('type', tok);
      else if (SQL_FUNCTIONS.has(u) && nextParen) out += span('fn', tok);
      else if (names.has(word) || names.has(word.toLowerCase())) out += span('tbl', tok);
      else if (u === 'TRUE' || u === 'FALSE' || u === 'NULL') out += span('const', tok);
      else out += esc(tok);
    } else if (op) out += span('op', tok);
    else if (punct) out += span('punct', tok);
  }
  return out + esc(src.slice(last));
}

/** redis-cli lines: the command word, key (second word), strings, numbers, # comments. */
export function highlightRedis(src: string): string {
  return src
    .split('\n')
    .map((line) => {
      if (/^\s*#/.test(line)) return span('cmt', line);
      const re = /("(?:[^"\\]|\\.)*"?|'[^']*'?)|(\S+)|(\s+)/g;
      let out = '';
      let word = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line))) {
        const [tok, str, w] = m;
        if (str) out += span('str', tok);
        else if (w) {
          out += word === 0 ? span('kw', tok) : word === 1 ? span('tbl', tok) : /^-?\d+(\.\d+)?$/.test(tok) ? span('num', tok) : /^(MATCH|COUNT|EX|PX|NX|XX|WITHSCORES|LIMIT|BY|GET|STORE|KEEPTTL|TYPE)$/i.test(tok) ? span('kw', tok) : esc(tok);
          word++;
        } else out += tok;
      }
      return out;
    })
    .join('\n');
}

const JS_KEYWORDS = new Set('true false null undefined new ObjectId ISODate Date'.split(' '));
const MONGO_METHODS = new Set('find findOne aggregate countDocuments count estimatedDocumentCount distinct insertOne insertMany updateOne updateMany replaceOne deleteOne deleteMany drop createIndex dropIndex getIndexes indexes sort limit skip project getCollection'.split(' '));

/** mongosh-like calls and JSON-ish bodies: db / collection / method, keys, strings, numbers, $operators. */
export function highlightMongo(src: string, names: Set<string> = new Set()): string {
  const re = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?)|(\/(?:[^/\\\n]|\\.)+\/[gimsuy]*)|(-?\b\d+(?:\.\d+)?\b)|(\$?[A-Za-z_][A-Za-z0-9_]*)|([{}[\]().,:;])|([<>=!+\-*/%|&]+)/g;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    out += esc(src.slice(last, m.index));
    last = re.lastIndex;
    const [tok, cmt, str, rx, num, word, punct, op] = m;
    if (cmt) out += span('cmt', tok);
    else if (str) out += span('str', tok);
    else if (rx) out += span('str', tok);
    else if (num) out += span('num', tok);
    else if (word) {
      const before = src.slice(0, m.index);
      const after = src.slice(last);
      if (word === 'db') out += span('kw', tok);
      else if (word.startsWith('$')) out += span('op', tok);
      else if (JS_KEYWORDS.has(word)) out += span('const', tok);
      else if (MONGO_METHODS.has(word) && /^\s*\(/.test(after)) out += span('fn', tok);
      else if (/db\.\s*$/.test(before) || names.has(word)) out += span('tbl', tok);
      else if (/^\s*:/.test(after)) out += span('key', tok);
      else out += esc(tok);
    } else if (punct) out += span('punct', tok);
    else if (op) out += span('op', tok);
  }
  return out + esc(src.slice(last));
}

/** Kibana-console requests: METHOD /path lines, then JSON bodies. */
export function highlightEs(src: string, names: Set<string> = new Set()): string {
  return src
    .split('\n')
    .map((line) => {
      const m = /^(\s*)(GET|POST|PUT|DELETE|HEAD)(\s+)(\S+)(.*)$/i.exec(line);
      if (m) {
        const path = m[4].replace(/^\/?([^/?]+)/, (all, idx: string) => (names.has(idx) ? `\u0000${idx}\u0001` : all));
        const pathHtml = esc(path).replace(/\u0000([^\u0001]+)\u0001/g, (_a, idx) => `<span class="hl-tbl">${idx}</span>`);
        return `${m[1]}${span('kw', m[2])}${m[3]}<span class="hl-ident">${pathHtml}</span>${esc(m[5])}`;
      }
      return highlightJson(line);
    })
    .join('\n');
}

/** JSON (and relaxed JSON): keys, strings, numbers, constants, brackets with a depth colour. */
export function highlightJson(src: string): string {
  const re = /("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?)(\s*:)?|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|(\btrue\b|\bfalse\b|\bnull\b)|([{}[\]])|([,:])|(\b[A-Za-z_$][A-Za-z0-9_$]*\b)(\s*:)/g;
  let out = '';
  let last = 0;
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    out += esc(src.slice(last, m.index));
    last = re.lastIndex;
    const [tok, str, colonAfterStr, num, konst, bracket, punct, bareKey, colonAfterKey] = m;
    if (str) out += span(colonAfterStr ? 'key' : 'str', str) + (colonAfterStr ? span('punct', colonAfterStr) : '');
    else if (num) out += span('num', tok);
    else if (konst) out += span('const', tok);
    else if (bracket) {
      if (bracket === '}' || bracket === ']') depth = Math.max(0, depth - 1);
      out += `<span class="hl-br hl-br-${depth % 3}">${bracket}</span>`;
      if (bracket === '{' || bracket === '[') depth++;
    } else if (punct) out += span('punct', tok);
    else if (bareKey) out += span('key', bareKey) + span('punct', colonAfterKey);
  }
  return out + esc(src.slice(last));
}

export function highlight(language: Language, src: string, names?: Set<string>): string {
  switch (language) {
    case 'sql':
      return highlightSql(src, names);
    case 'redis':
      return highlightRedis(src);
    case 'mongo':
      return highlightMongo(src, names);
    case 'es':
      return highlightEs(src, names);
    case 'json':
      return highlightJson(src);
  }
}

/** Pretty JSON when the text parses, else null. */
export function prettyJson(text: string): string | null {
  const t = text.trim();
  if (!/^[{[]/.test(t)) return null;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return null;
  }
}
