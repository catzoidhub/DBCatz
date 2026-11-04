import { expect, test } from 'bun:test';
import type { DvResult } from '@shared/types';
import { resultsOut } from '../src/main/mcatzp/actions';

const r = (statement: string, columns: string[], rows: unknown[][]): DvResult => ({ statement, columns, rows, affected: null, ms: 1, error: null });
const rowsOf = (x: unknown) => (x as { rows: unknown[] }[])[0].rows;

test('a secret column goes out masked, others do not', () => {
  expect(rowsOf(resultsOut([r('SELECT name, password FROM u', ['name', 'password'], [['a', 'p']])], 10, 'mysql'))).toEqual([{ name: 'a', password: '•••' }]);
});
test('an alias or a function does not take the mask off', () => {
  expect(rowsOf(resultsOut([r('SELECT password AS x FROM u', ['x'], [['p']])], 10, 'postgresql'))).toEqual([{ x: '•••' }]);
  expect(rowsOf(resultsOut([r('SELECT password x FROM u', ['x'], [['p']])], 10, 'mysql'))).toEqual([{ x: '•••' }]);
  expect(rowsOf(resultsOut([r('SELECT upper(password), password FROM u', ['upper', 'password'], [['P', 'p']])], 10, 'postgresql'))).toEqual([{ upper: '•••', password: '•••' }]);
});
test('a word in a string is not a secret column', () => {
  expect(rowsOf(resultsOut([r("SELECT id FROM u WHERE note = 'password'", ['id'], [[1]])], 10, 'mysql'))).toEqual([{ id: 1 }]);
});
test('Redis: the key or field named, and HGETALL field by field', () => {
  expect(rowsOf(resultsOut([r('GET api_token', ['reply'], [['tk']])], 10, 'redis'))).toEqual([{ reply: '•••' }]);
  expect(rowsOf(resultsOut([r('HGET h password', ['reply'], [['p']])], 10, 'valkey'))).toEqual([{ reply: '•••' }]);
  expect(rowsOf(resultsOut([r('HGETALL h', ['reply'], [['password'], ['p'], ['n'], ['1']])], 10, 'redis'))).toEqual([{ reply: 'password' }, { reply: '•••' }, { reply: 'n' }, { reply: '1' }]);
  expect(rowsOf(resultsOut([r('GET a', ['reply'], [['hello']])], 10, 'redis'))).toEqual([{ reply: 'hello' }]);
});
