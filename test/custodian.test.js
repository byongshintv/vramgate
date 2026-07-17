import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VramgateClient } from '../src/client.js';
import { createCustodian } from '../src/custodian.js';
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
