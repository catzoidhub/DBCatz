import { expect, test } from 'bun:test';
import { buildLabel } from '@shared/platform';

test('the build is named with its OS', () => {
  expect(buildLabel('mac', 'arm64')).toBe('macOS Apple silicon');
  expect(buildLabel('mac', 'x64')).toBe('macOS Intel');
  expect(buildLabel('windows', 'x64')).toBe('Windows x64');
  expect(buildLabel('windows', 'arm64')).toBe('Windows ARM64');
  expect(buildLabel('linux', 'x64')).toBe('Linux x64');
  expect(buildLabel('linux', 'arm64')).toBe('Linux ARM64');
  expect(buildLabel('mac', '')).toBe('');
});
