import { expect, test } from 'bun:test';
import { maskSecrets as m } from '@shared/mask';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcDEF123_-x';

test('auth headers and tokens with no name in front', () => {
  expect(m('Authorization: Bearer abcdefgh12345')).not.toContain('abcdefgh12345');
  expect(m('authorization=Basic dXNlcjpwYXNz')).not.toContain('dXNlcjpwYXNz');
  expect(m('Proxy-Authorization: Digest username="a", response="b"')).not.toContain('response="b"');
  expect(m('curl -H "Authorization: token ghx1234567890"')).not.toContain('ghx1234567890');
  expect(m('sent bearer abcdefgh12345 to it')).not.toContain('abcdefgh12345');
  expect(m('Basic dXNlcjpwYXNz')).not.toContain('dXNlcjpwYXNz');
  expect(m(`cookie was ${JWT} here`)).not.toContain(JWT);
  expect(m('{"Authorization":"Bearer abcdefgh12345"}')).not.toContain('abcdefgh12345');
});

test('what was already masked stays masked', () => {
  expect(m("IDENTIFIED BY 'hunter2'")).not.toContain('hunter2');
  expect(m('password=hunter2')).not.toContain('hunter2');
  expect(m('postgres://me:hunter2@db/x')).not.toContain('hunter2');
  expect(m('api_key: abc123')).not.toContain('abc123');
});

test('ordinary words stay', () => {
  for (const t of ['SELECT * FROM users WHERE id = 1', 'basic information about the plan', 'the bearer of this letter', 'a token of thanks', 'eyJ is how it starts']) expect(m(t)).toBe(t);
});
