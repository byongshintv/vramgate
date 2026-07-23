import test from 'node:test';
import assert from 'node:assert/strict';
import { createGpuQuery } from '../src/gpu.js';

test('GPU query supports injection and caches the last successful value', async () => {
  let calls = 0;
  const query = createGpuQuery({
    queryFn: async index => {
      assert.equal(index, 2);
      if (calls++ === 0) return { used: 1234, total: 16384 };
      throw new Error('offline');
    },
    index: 2,
    logger: null
  });
  assert.deepEqual(await query(), {
    used: 1234, total: 16384, queryHealthy: true,
    consecutiveFailures: 0, hasSuccessfulReading: true
  });
  assert.deepEqual(await query(), {
    used: 1234, total: 16384, queryHealthy: false,
    consecutiveFailures: 1, hasSuccessfulReading: true
  });
});

test('GPU query falls back to configured total before first success', async () => {
  const query = createGpuQuery({
    queryFn: async () => { throw new Error('missing'); },
    totalMib: 24576,
    logger: null
  });
  assert.deepEqual(await query(), {
    used: 0, total: 24576, queryHealthy: false,
    consecutiveFailures: 1, hasSuccessfulReading: false
  });
});
