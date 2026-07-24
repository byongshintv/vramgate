import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecoder, encodeMessage } from '../src/protocol.js';

test('decoder parses newline-delimited JSON messages', () => {
  const seen = [];
  const decoder = createDecoder(message => seen.push(message));
  decoder.push(encodeMessage({ type: 'a' }));
  decoder.push('{"type":"b"}\n{"type":"c"}\n');
  assert.deepEqual(seen, [{ type: 'a' }, { type: 'b' }, { type: 'c' }]);
});

test('decoder reports invalid JSON without aborting the stream', () => {
  const seen = [];
  const errors = [];
  const decoder = createDecoder(m => seen.push(m), e => errors.push(e));
  decoder.push('not json\n{"type":"ok"}\n');
  assert.equal(errors.length, 1);
  assert.deepEqual(seen, [{ type: 'ok' }]);
});

test('decoder overflows and stops when a message exceeds the byte cap', () => {
  const seen = [];
  let overflow = null;
  const decoder = createDecoder(
    m => seen.push(m),
    () => {},
    { maxBytes: 64, onOverflow: e => { overflow = e; } }
  );
  decoder.push('x'.repeat(100)); // no newline, exceeds cap
  assert.ok(overflow instanceof Error);
  assert.match(overflow.message, /exceeds 64 bytes/);
  assert.equal(decoder.buffer, '');
  // subsequent pushes are ignored (connection is considered poisoned)
  decoder.push('{"type":"ignored"}\n');
  assert.deepEqual(seen, []);
});

test('decoder does not overflow when messages are terminated within the cap', () => {
  const seen = [];
  let overflow = null;
  const decoder = createDecoder(
    m => seen.push(m),
    () => {},
    { maxBytes: 64, onOverflow: e => { overflow = e; } }
  );
  // Each message is small; total bytes across messages far exceed the cap.
  for (let i = 0; i < 50; i++) decoder.push(encodeMessage({ i }));
  assert.equal(overflow, null);
  assert.equal(seen.length, 50);
});
