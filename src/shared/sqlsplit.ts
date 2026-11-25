import type { DbEngine } from './types';

/**
 * Splits a script into statements on `;` outside quotes, comments and
 * PostgreSQL dollar quotes (good enough for the query editor and imports).
 */
export function splitStatements(sql: string): string[] {
  return split(sql, false);
}

/**
 * A script file as the mysql client reads it: DELIMITER lines change what ends a statement (triggers, procedures,
 * events in a mysqldump). Imports only: the query guards look at statements split on `;`, and MySQL runs several in one
 * call, so a DELIMITER there could carry a write past them.
 */
export function splitScript(sql: string): string[] {
  return split(sql, true);
}

/** Where MySQL's executable comment that opens at `i` ends: past the strings, line comments and comments inside it. */
function executableEnd(sql: string, i: number): number {
  let j = i + 3;
  while (j < sql.length) {
    const c = sql[j];
    if (c === '*' && sql[j + 1] === '/') return j + 2;
    if (c === '/' && sql[j + 1] === '*') {
      const e = sql.indexOf('*/', j + 2);
      if (e < 0) return sql.length;
      j = e + 2;
    } else if ((c === '-' && sql[j + 1] === '-' && /\s/.test(sql[j + 2] ?? ' ')) || c === '#') {
      const e = sql.indexOf('\n', j);
      const end = e < 0 ? sql.length : e;
      // A comment on the last line also holds the closing mark.
      const close = sql.indexOf('*/', j);
      if (close >= 0 && close < end) return close + 2;
      j = end;
    } else if (c === "'" || c === '"' || c === '`') {
      j++;
      while (j < sql.length && sql[j] !== c) j += sql[j] === '\\' && c !== '`' ? 2 : 1;
      j++;
    } else j++;
  }
  return sql.length;
}

function split(sql: string, script: boolean): string[] {
  const out: string[] = [];
  let cur = '';
  let i = 0;
  let delimiter = ';';
  const command = /DELIMITER[ \t]+(\S+)[^\n]*/iy;
  while (i < sql.length) {
    const c = sql[i];
    const n = sql[i + 1];
    if (script && (c === 'D' || c === 'd') && (i === 0 || sql[i - 1] === '\n') && !cur.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, '').trim()) {
      command.lastIndex = i;
      const m = command.exec(sql);
      if (m) {
        delimiter = m[1];
        cur = '';
        i += m[0].length;
        continue;
      }
    }
    // MySQL's own rules in a script: -- needs a space after it, # starts a comment anywhere, $ quotes nothing.
    if (c === '-' && n === '-' && (!script || /\s/.test(sql[i + 2] ?? ' '))) {
      const e = sql.indexOf('\n', i);
      const end = e < 0 ? sql.length : e;
      cur += sql.slice(i, end);
      i = end;
      continue;
    }
    if (c === '#' && (script || cur.trim() === '' || /\n\s*$/.test(cur))) {
      const e = sql.indexOf('\n', i);
      const end = e < 0 ? sql.length : e;
      // Inside a procedure the comment is part of its text.
      if (script && cur.trim()) cur += sql.slice(i, end);
      i = end;
      continue;
    }
    if (c === '/' && n === '*') {
      const e = sql.indexOf('*/', i + 2);
      const end = script && sql[i + 2] === '!' ? executableEnd(sql, i) : e < 0 ? sql.length : e + 2;
      cur += sql.slice(i, end);
      i = end;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === '\\' && c !== '`') j += 2;
        else if (sql[j] === c && sql[j + 1] === c) j += 2;
        else if (sql[j] === c) break;
        else j++;
      }
      cur += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (!script && c === '$') {
      const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const e = sql.indexOf(tag, i + tag.length);
        const end = e < 0 ? sql.length : e + tag.length;
        cur += sql.slice(i, end);
        i = end;
        continue;
      }
    }
    if (c === delimiter[0] && (delimiter.length === 1 || sql.startsWith(delimiter, i))) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      i += delimiter.length;
      continue;
    }
    cur += c;
    i++;
  }
  if (cur.trim()) out.push(cur.trim());
  // A statement that is only comments is dropped — but MySQL / MariaDB run what is in /*! … */ and /*M! … */ (a
  // mysqldump turns its foreign key checks off that way).
  return out.filter((s) => s.replace(/--[^\n]*|\/\*(?!M?!)[\s\S]*?\*\//g, '').trim());
}

/** A query box's text as the statements it runs, one by one: what a guard checks is what runs. */
export function splitQuery(engine: DbEngine, text: string): string[] {
  if (engine === 'mysql' || engine === 'mariadb' || engine === 'postgresql' || engine === 'sqlite') return splitStatements(text);
  if (engine === 'mongodb') return text.split(/\n(?=db\.|\{)/).filter((s) => s.trim());
  if (engine === 'elasticsearch') return text.split(/\n(?=(?:GET|POST|PUT|DELETE|HEAD)\s)/i).filter((s) => s.trim());
  return text.split('\n').filter((s) => s.trim() && !s.trim().startsWith('#'));
}
