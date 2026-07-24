import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VramgateDaemon } from '../src/daemon.js';
import { VramBusyError, VramgateClient } from '../src/client.js';

async function setup(t, { gpu = { used: 0, total: 17408 }, budget = 17408, idleThreshold = 1536 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vramgate-'));
  const socket = join(directory, 'gate.sock');
  let reading = gpu;
  const daemon = new VramgateDaemon({
    socket,
    budget,
    reserve: 0,
    safety: 1024,
    idleThreshold,
    poll: 100000,
    queryFn: async () => reading,
    logger: null
  });
  await daemon.start();
  t.after(async () => daemon.close());
  return { daemon, socket, setGpu(value) { reading = value; } };
}

function remainsPending(promise, ms = 40) {
  return Promise.race([
    promise.then(() => false, () => false),
    new Promise(resolve => setTimeout(() => resolve(true), ms))
  ]);
}

test('strict admission queues 16G until both 8G leases release', async t => {
  const { socket } = await setup(t);
  const a = new VramgateClient({ socket, failOpen: false });
  const b = new VramgateClient({ socket, failOpen: false });
  const c = new VramgateClient({ socket, failOpen: false });
  t.after(() => { a.close(); b.close(); c.close(); });
  const leaseA = await a.acquire(8192, { label: 'A' });
  const leaseB = await b.acquire(8192, { label: 'B' });
  const waitingC = c.acquire(16384, { label: 'C' });
  assert.equal(await remainsPending(waitingC), true);
  await leaseA.release();
  assert.equal(await remainsPending(waitingC), true);
  await leaseB.release();
  const leaseC = await waitingC;
  assert.equal(leaseC.mib, 16384);
  await leaseC.release();
});

test('acquire timeout is fail-closed after a successful connection', async t => {
  const context = await setup(t, { gpu: { used: 16000, total: 17408 } });
  const client = new VramgateClient({ socket: context.socket });
  t.after(() => client.close());
  await assert.rejects(
    client.acquire(1024, { timeoutMs: 20 }),
    error => error instanceof VramBusyError && error.code === 'VRAM_BUSY'
  );
});

test('preemptible request waits for idle window and is then granted', async t => {
  const context = await setup(t, { idleThreshold: 100 });
  context.setGpu({ used: 200, total: 17408 });
  await context.daemon.poll();
  const client = new VramgateClient({ socket: context.socket, failOpen: false });
  t.after(() => client.close());
  const waiting = client.acquire(1024, { preemptible: true, idleWindowMs: 30 });
  assert.equal(await remainsPending(waiting, 15), true);
  context.setGpu({ used: 0, total: 17408 });
  await context.daemon.poll();
  assert.equal(await remainsPending(waiting, 15), true);
  await new Promise(resolve => setTimeout(resolve, 20));
  await context.daemon.poll();
  const lease = await waiting;
  assert.equal(lease.preemptible, true);
  await lease.release();
});

test('non-preemptible waiter sends preempt to active preemptible lease', async t => {
  const context = await setup(t, { gpu: { used: 0, total: 4096 }, budget: 4096 });
  context.daemon.lastBusyAt = Date.now() - 1000;
  const training = new VramgateClient({ socket: context.socket, failOpen: false });
  const foreground = new VramgateClient({ socket: context.socket, failOpen: false });
  t.after(() => { training.close(); foreground.close(); });
  const lease = await training.acquire(2048, { preemptible: true, idleWindowMs: 10 });
  const preempted = lease.preempted;
  const waiting = foreground.acquire(2048);
  const message = await preempted;
  assert.equal(message.leaseId, lease.leaseId);
  assert.equal(await remainsPending(waiting), true);
  await lease.release();
  const foregroundLease = await waiting;
  await foregroundLease.release();
});

test('external usage blocks a new managed request', async t => {
  const context = await setup(t, { gpu: { used: 0, total: 14336 }, budget: 14336 });
  context.setGpu({ used: 6144, total: 14336 });
  await context.daemon.poll();
  const blocker = new VramgateClient({ socket: context.socket, failOpen: false });
  const waiting = blocker.acquire(8 * 1024);
  t.after(() => blocker.close());
  assert.equal(await remainsPending(waiting), true);
});

test('closing a connection releases all of its leases and rescans', async t => {
  const { socket } = await setup(t, { gpu: { used: 0, total: 32768 }, budget: 31744 });
  const owner = new VramgateClient({ socket, failOpen: false });
  const waiter = new VramgateClient({ socket, failOpen: false });
  t.after(() => { owner.close(); waiter.close(); });
  await owner.acquire(24 * 1024);
  const pending = waiter.acquire(16 * 1024);
  assert.equal(await remainsPending(pending), true);
  owner.close();
  const lease = await pending;
  assert.equal(lease.mib, 16 * 1024);
  await lease.release();
});

test('immediate preempt delivered with grant is not lost', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'vramgate-'));
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
  const cache = new VramgateClient({ socket, failOpen: false });
  const foreground = new VramgateClient({ socket, failOpen: false });
  t.after(() => cache.close());
  t.after(() => foreground.close());

  const waiting = foreground.acquire(3072, { label: 'foreground' });
  const adopted = await cache.acquire(2048, {
    label: 'cache:test', preemptible: true, adopt: true, priority: -1000
  });
  const preempt = await Promise.race([
    adopted.preempted,
    new Promise((_, reject) => setTimeout(() => reject(new Error('preempt lost')), 500))
  ]);

  assert.equal(preempt.leaseId, adopted.leaseId);
  await adopted.release();
  const lease = await waiting;
  await lease.release();
});

test('cache adoption queues behind an active same-model request', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'vramgate-'));
  const socket = join(directory, 'gate.sock');
  const daemon = new VramgateDaemon({
    socket, budget: 4096, reserve: 0, safety: 0, idleThreshold: 1536,
    poll: 100000, queryFn: async () => ({ used: 0, total: 4096 }), logger: null
  });
  await daemon.start();
  t.after(() => daemon.close());
  const cache = new VramgateClient({ socket, failOpen: false });
  const first = new VramgateClient({ socket, failOpen: false });
  const second = new VramgateClient({ socket, failOpen: false });
  t.after(() => cache.close());
  t.after(() => first.close());
  t.after(() => second.close());

  const cached = await cache.acquire(3072, {
    label: 'cache:ollama', preemptible: true, adopt: true, priority: -1000
  });
  const active = await first.acquire(3072, {
    label: 'ollama:model:qwen:14b', adopt: true, adoptFromLabel: 'cache:ollama'
  });
  const waiting = second.acquire(3072, {
    label: 'ollama:model:qwen:14b', adopt: true, adoptFromLabel: 'cache:ollama'
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(daemon.status().queue.length, 1);

  await cached.release();
  await active.release();
  const next = await waiting;
  await next.release();
});

test('GPU query failures block new grants after the configured threshold and recover', async t => {
  const context = await setup(t);
  context.daemon.gpuFailureLimit = 2;
  context.setGpu(Promise.reject(new Error('driver offline')));
  await context.daemon.poll();
  assert.equal(context.daemon.status().admissionBlocked, false);
  await context.daemon.poll();
  assert.equal(context.daemon.status().admissionBlocked, true);

  const client = new VramgateClient({ socket: context.socket, failOpen: false });
  t.after(() => client.close());
  const waiting = client.acquire(1024, { label: 'blocked-during-driver-failure' });
  assert.equal(await remainsPending(waiting), true);

  context.setGpu({ used: 0, total: 17408 });
  await context.daemon.poll();
  const lease = await waiting;
  assert.equal(context.daemon.status().admissionBlocked, false);
  await lease.release();
});

test('audit logger records queue, grant, release, and connection cleanup', async t => {
  const lines = [];
  const directory = await mkdtemp(join(tmpdir(), 'vramgate-audit-'));
  const socket = join(directory, 'gate.sock');
  const daemon = new VramgateDaemon({
    socket, budget: 4096, reserve: 0, safety: 0, poll: 100000,
    queryFn: async () => ({ used: 0, total: 4096 }),
    logger: { info: line => lines.push(line), warn() {} }
  });
  await daemon.start();
  t.after(async () => daemon.close());
  const client = new VramgateClient({ socket, failOpen: false });
  const lease = await client.acquire(1024, { label: 'audit-test' });
  await lease.release();
  client.close();
  assert.ok(lines.some(line => line.includes('"event":"queue"')));
  assert.ok(lines.some(line => line.includes('"event":"grant"')));
  assert.ok(lines.some(line => line.includes('"event":"release"')));
  assert.ok(lines.every(line => line.startsWith('vramgate:audit ')));
});
