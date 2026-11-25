import { describe, expect, test } from 'bun:test';
import { statementKind } from '../src/shared/dbsafety';
import { splitScript, splitStatements } from '../src/shared/sqlsplit';

describe('splitStatements', () => {
  test('keeps executable comments, drops plain ones', () => {
    expect(splitStatements('-- a\n/* b */;\n/*!40014 SET FOREIGN_KEY_CHECKS=0 */;\n/*M!100100 SET x=1 */;\nSELECT 1;')).toEqual([
      '/*!40014 SET FOREIGN_KEY_CHECKS=0 */',
      '/*M!100100 SET x=1 */',
      'SELECT 1',
    ]);
  });
});

describe('splitScript', () => {
  test('DELIMITER lines change what ends a statement', () => {
    expect(splitScript("SELECT 1;\n-- x\nDELIMITER ;;\nCREATE PROCEDURE p() BEGIN SELECT ';;'; SELECT 2; END ;;\nDELIMITER ;\nSELECT 3;")).toEqual(['SELECT 1', "CREATE PROCEDURE p() BEGIN SELECT ';;'; SELECT 2; END", 'SELECT 3']);
  });
  test('a trigger inside executable comments, with strings and comments of its own', () => {
    const t = "/*!50003 CREATE*/ /*!50017 DEFINER=`a`@`b`*/ /*!50003 TRIGGER t BEFORE INSERT ON x FOR EACH ROW BEGIN /* it's */ SET NEW.a = '*/'; -- don't\n END */";
    expect(splitScript(`DELIMITER ;;\n${t};;\nDELIMITER ;\nSELECT 1;`)).toEqual([t, 'SELECT 1']);
  });
  test('# comments, $$ as the delimiter, 5--1', () => {
    expect(splitScript("DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 5--1; # won't\n SELECT 2; END$$\nDELIMITER ;\nSELECT 3;")).toEqual(['CREATE PROCEDURE p() BEGIN SELECT 5--1; # won\'t\n SELECT 2; END', 'SELECT 3']);
  });
  test('a column named delimiter, and the query box, are left alone', () => {
    expect(splitScript('SELECT\ndelimiter x FROM t;')).toEqual(['SELECT\ndelimiter x FROM t']);
    expect(splitStatements('DELIMITER ;;\nSELECT 1; DROP TABLE t;;').length).toBe(3);
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
