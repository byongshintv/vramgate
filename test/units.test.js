import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMib } from '../src/units.js';

test('memory units parse to integer MiB', () => {
  assert.equal(parseMib('8G'), 8192);
  assert.equal(parseMib('8192M'), 8192);
  assert.equal(parseMib('8192'), 8192);
  assert.equal(parseMib(512), 512);
  assert.throws(() => parseMib('1.5G'));
  assert.throws(() => parseMib(-1));
});
