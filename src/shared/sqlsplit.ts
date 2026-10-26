/**
 * Splits a script into statements on `;` outside quotes, comments and
 * PostgreSQL dollar quotes (good enough for the query editor and imports).
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const n = sql[i + 1];
    if (c === '-' && n === '-') {
      const e = sql.indexOf('\n', i);
      const end = e < 0 ? sql.length : e;
      cur += sql.slice(i, end);
      i = end;
      continue;
    }
    if (c === '#' && (cur.trim() === '' || /\n\s*$/.test(cur))) {
      const e = sql.indexOf('\n', i);
      i = e < 0 ? sql.length : e;
      continue;
    }
    if (c === '/' && n === '*') {
      const e = sql.indexOf('*/', i + 2);
      const end = e < 0 ? sql.length : e + 2;
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
    if (c === '$') {
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
    if (c === ';') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  if (cur.trim()) out.push(cur.trim());
  // A statement that is only comments is dropped.
  return out.filter((s) => s.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, '').trim());
}
