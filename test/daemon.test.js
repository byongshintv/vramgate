import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VramgateDaemon } from '../src/daemon.js';
import { VramgateClient } from '../src/client.js';

async function setup(t, { gpu = { used: 0, total: 17408 }, budget = 17408 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vramgate-'));
  const socket = join(directory, 'gate.sock');
  let reading = gpu;
  const daemon = new VramgateDaemon({
    socket,
    budget,
    reserve: 0,
    safety: 1024,
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
