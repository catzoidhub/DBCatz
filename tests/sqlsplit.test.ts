import { describe, expect, test } from 'bun:test';
import { statementKind } from '../src/shared/dbsafety';
import { splitStatements } from '../src/shared/sqlsplit';

describe('splitStatements', () => {
  test('keeps executable comments, drops plain ones', () => {
    expect(splitStatements('-- a\n/* b */;\n/*!40014 SET FOREIGN_KEY_CHECKS=0 */;\n/*M!100100 SET x=1 */;\nSELECT 1;')).toEqual([
      '/*!40014 SET FOREIGN_KEY_CHECKS=0 */',
      '/*M!100100 SET x=1 */',
      'SELECT 1',
    ]);
  });
});

describe('statementKind with executable comments', () => {
  const k = (s: string) => statementKind('mysql', s);
  test('what they run counts', () => {
    expect(k('/*!50000 DROP TABLE t */')).toMatchObject({ read: false, destructive: true });
    expect(k('/*!99999 SELECT 1 */ DELETE FROM t')).toMatchObject({ read: false, destructive: true });
    expect(k('/*!99999 SELECT 1 */ /*!50000 DROP TABLE t */')).toMatchObject({ read: false, destructive: true });
    expect(k("SELECT 1 /*! INTO OUTFILE '/tmp/x' */").read).toBe(false);
  });
  test('harmless ones stay reads', () => {
    expect(k('SELECT /*!40001 SQL_NO_CACHE */ * FROM t').read).toBe(true);
    expect(k("SELECT '/*!50000 DROP TABLE t */'").read).toBe(true);
    expect(k('/*!40101 SET NAMES utf8mb4 */').read).toBe(true);
  });
  test('PostgreSQL: a comment is only a comment', () => {
    expect(statementKind('postgresql', '/*! SELECT 1 */ DROP TABLE t').destructive).toBe(true);
  });
});
