import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDurationMs, parseMib } from '../src/units.js';

test('memory units parse to integer MiB', () => {
  assert.equal(parseMib('8G'), 8192);
  assert.equal(parseMib('8192M'), 8192);
  assert.equal(parseMib('8192'), 8192);
  assert.equal(parseMib(512), 512);
  assert.throws(() => parseMib('1.5G'));
  assert.throws(() => parseMib(-1));
});

test('duration units parse to milliseconds and bare values mean seconds', () => {
  assert.equal(parseDurationMs('5m'), 300000);
  assert.equal(parseDurationMs('30s'), 30000);
  assert.equal(parseDurationMs('90'), 90000);
  assert.equal(parseDurationMs('250ms'), 250);
  assert.throws(() => parseDurationMs('-1s'));
});
