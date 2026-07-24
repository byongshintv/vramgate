import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VramgateClient } from '../src/client.js';
import { BACKENDS, createCustodian, fetchWithRetry } from '../src/custodian.js';
import { VramgateDaemon } from '../src/daemon.js';

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'vramgate-custodian-'));
  const socket = join(directory, 'gate.sock');
  const daemon = new VramgateDaemon({
    socket,
    budget: 4096,
    reserve: 0,
    safety: 0,
    idleThreshold: 1536,
    poll: 100000,
    queryFn: async () => ({ used: 0, total: 4096 }),
    logger: null
  });
  await daemon.start();
  t.after(() => daemon.close());

  let resident = 2048;
  let unloads = 0;
  const adapter = {
    sameBackendLabels: new Set(['llm']),
    async queryResidentMib() { return resident; },
    async unload() {
      unloads++;
      resident = 0;
    }
  };
  const custodian = createCustodian({ backend: adapter, socket, minMib: 300 });
  t.after(() => custodian.client.close());
  return {
    adapter,
    custodian,
    daemon,
    socket,
    get unloads() { return unloads; }
  };
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for condition');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('resident memory above minMib is represented by a preemptible lease', async t => {
  const context = await setup(t);
  await context.custodian.ensureLease();

  const status = context.daemon.status();
  assert.equal(status.granted, 2048);
  assert.equal(status.leases.length, 1);
  assert.equal(status.leases[0].preemptible, true);
  assert.equal(status.leases[0].label, 'cache:custom');
});

test('incompatible resident is evicted when same-backend demand exists before cache lease', async t => {
  const context = await setup(t);
  context.adapter.shouldUnload = async () => true;
  const llm = new VramgateClient({ socket: context.socket, failOpen: false });
  t.after(() => llm.close());
  const lease = await llm.acquire(1024, { label: 'llm' });

  await context.custodian.ensureLease();

  assert.equal(context.unloads, 1);
  assert.equal(context.custodian.lease, null);
  await lease.release();
});

test('adopts already-counted external resident memory without requiring headroom', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'vramgate-custodian-adopt-'));
  const socket = join(directory, 'gate.sock');
  const resident = 3800;
  const daemon = new VramgateDaemon({
    socket,
    budget: 4096,
    reserve: 0,
    safety: 512,
    idleThreshold: 4096,
    poll: 100000,
    queryFn: async () => ({ used: resident, total: 4096 }),
    logger: null
  });
  await daemon.start();
  t.after(() => daemon.close());
  const adapter = {
    name: 'resident-test',
    sameBackendLabels: new Set(['llm']),
    async queryResidentMib() { return resident; },
    async unload() {}
  };
  const custodian = createCustodian({ backend: adapter, socket, minMib: 300 });
  t.after(() => custodian.client.close());

  await custodian.ensureLease();

  assert.notEqual(custodian.lease, null);
  assert.equal(daemon.status().granted, resident);
  assert.equal(daemon.status().leases[0].label, 'cache:resident-test');
});

test('different-backend demand unloads resident models and releases the cache lease', async t => {
  const context = await setup(t);
  await context.custodian.ensureLease();
  const foreground = new VramgateClient({ socket: context.socket, failOpen: false });
  t.after(() => foreground.close());

  const waiting = foreground.acquire(3072, { label: 'game' });
  await waitFor(() => context.unloads === 1 && context.custodian.lease === null);
  const lease = await waiting;

  assert.equal(context.unloads, 1);
  assert.equal(context.custodian.lease, null);
  await lease.release();
});

test('same-backend demand yields the cache lease without unloading models', async t => {
  const context = await setup(t);
  await context.custodian.ensureLease();
  const llm = new VramgateClient({ socket: context.socket, failOpen: false });
  t.after(() => llm.close());

  const waiting = llm.acquire(3072, { label: 'llm' });
  await waitFor(() => context.custodian.lease === null);
  const lease = await waiting;

  assert.equal(context.unloads, 0);
  assert.equal(context.custodian.lease, null);
  await lease.release();
});

test('model-specific Ollama demand is treated as the same backend', async t => {
  const context = await setup(t);
  await context.custodian.ensureLease();
  const llm = new VramgateClient({ socket: context.socket, failOpen: false });
  t.after(() => llm.close());

  const waiting = llm.acquire(3072, { label: 'ollama:model:qwen3-opencode:14b' });
  await waitFor(() => context.custodian.lease === null);
  const lease = await waiting;

  assert.equal(context.unloads, 0);
  await lease.release();
});

test('fetchWithRetry succeeds after two transient failures', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    if (attempts < 3) throw new Error('fetch failed');
    return { ok: true };
  };

  const response = await fetchWithRetry('http://example.test', undefined, {
    retries: 3,
    backoffMs: 0,
    logger: null
  });

  assert.equal(response.ok, true);
  assert.equal(attempts, 3);
});

test('fetchWithRetry throws after all attempts fail', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    throw new Error('fetch failed');
  };

  await assert.rejects(fetchWithRetry('http://example.test', undefined, {
    retries: 3,
    backoffMs: 0,
    logger: null
  }), /fetch failed/);
  assert.equal(attempts, 3);
});

test('cache lease release requires consecutive below-minimum confirmations', async t => {
  const context = await setup(t);
  let resident = 2048;
  context.adapter.queryResidentMib = async () => resident;
  await context.custodian.ensureLease();

  resident = 0;
  await context.custodian.tick();
  assert.notEqual(context.custodian.lease, null);

  resident = 2048;
  await context.custodian.tick();
  resident = 0;
  await context.custodian.tick();
  assert.notEqual(context.custodian.lease, null);

  await context.custodian.tick();
  assert.equal(context.custodian.lease, null);
  assert.equal(context.daemon.status().leases.length, 0);
});

test('ollama labels default to llm and vlm and can be replaced from env', t => {
  const previous = process.env.VRAMGATE_OLLAMA_LABELS;
  t.after(() => {
    if (previous === undefined) delete process.env.VRAMGATE_OLLAMA_LABELS;
    else process.env.VRAMGATE_OLLAMA_LABELS = previous;
  });

  delete process.env.VRAMGATE_OLLAMA_LABELS;
  assert.deepEqual(BACKENDS.ollama({ logger: null }).sameBackendLabels, new Set(['llm', 'vlm']));

  process.env.VRAMGATE_OLLAMA_LABELS = ' llm, embed, ,custom ';
  assert.deepEqual(
    BACKENDS.ollama({ logger: null }).sameBackendLabels,
    new Set(['llm', 'embed', 'custom'])
  );
});

test('Ollama model-aware preemption reuses equal weights and unloads different weights', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return { models: [{ name: 'qwen3-opencode:14b', size_vram: 1024 }] };
    }
  });
  const backend = BACKENDS.ollama({ logger: null });
  const statusFor = label => ({
    leases: [],
    queue: [{ label, preemptible: false }]
  });

  assert.equal(
    await backend.shouldUnload(statusFor('ollama:model:qwen3-opencode:14b')),
    false
  );
  assert.equal(
    await backend.shouldUnload(statusFor('ollama:model:another-model:14b')),
    true
  );
});

test('active vlm demand prevents ollama model unload on preemption', async t => {
  const context = await setup(t);
  context.adapter.sameBackendLabels = new Set(['llm', 'vlm']);
  await context.custodian.ensureLease();
  const vlm = new VramgateClient({ socket: context.socket, failOpen: false });
  t.after(() => vlm.close());

  const waiting = vlm.acquire(3072, { label: 'vlm' });
  await waitFor(() => context.custodian.lease === null);
  const lease = await waiting;

  assert.equal(context.unloads, 0);
  await lease.release();
});
