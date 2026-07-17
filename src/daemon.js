import net from 'node:net';
import { unlink } from 'node:fs/promises';
import { createGpuQuery } from './gpu.js';
import { createDecoder, encodeMessage } from './protocol.js';

export function defaultSocketPath(env = process.env) {
  return `${env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 0}`}/vramgate.sock`;
}

export class VramgateDaemon {
  constructor(options = {}) {
    this.socket = options.socket ?? defaultSocketPath();
    this.reserve = Number(options.reserve ?? options.reserveMib ?? 1024);
    this.safety = Number(options.safety ?? options.safetyMib ?? 512);
    this.pollMs = Number(options.poll ?? options.pollMs ?? 2000);
    this.budget = options.budget == null ? null : Number(options.budget);
    this.live = { used: 0, total: this.budget == null ? 0 : this.budget + this.reserve };
    this.queryGpu = createGpuQuery({
      index: Number(options.gpu ?? options.gpuIndex ?? 0),
      queryFn: options.queryFn,
      totalMib: this.live.total,
      logger: options.logger
    });
    this.leases = new Map();
    this.queue = [];
    this.sequence = 0;
    this.leaseSequence = 0;
    this.server = null;
    this.timer = null;
    this.connections = new Set();
  }

  get granted() {
    let value = 0;
    for (const lease of this.leases.values()) value += lease.mib;
    return value;
  }

  get external() {
    return Math.max(0, this.live.used - this.granted);
  }

  get physicalLimit() {
    return this.budget == null ? this.live.total : this.budget + this.reserve;
  }

  async start() {
    if (this.server) return this;
    await this.poll();
    if (this.budget == null) this.budget = Math.max(0, this.live.total - this.reserve);
    await unlink(this.socket).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    this.server = net.createServer(socket => this.handleConnection(socket));
    await new Promise((resolve, reject) => {
      const onError = error => reject(error);
      this.server.once('error', onError);
      this.server.listen(this.socket, () => {
        this.server.off('error', onError);
        resolve();
      });
    });
    this.timer = setInterval(() => void this.poll(), this.pollMs);
    this.timer.unref?.();
    return this;
  }

  async poll() {
    this.live = await this.queryGpu();
    this.scanQueue();
    return this.live;
  }

  handleConnection(socket) {
    this.connections.add(socket);
    socket.setEncoding('utf8');
    const state = { socket, leaseIds: new Set(), pending: new Set(), closed: false };
    const decoder = createDecoder(
      message => this.handleMessage(state, message),
      error => this.send(socket, { type: 'error', error: `invalid JSON: ${error.message}` })
    );
    socket.on('data', chunk => decoder.push(chunk));
    const cleanup = () => {
      if (state.closed) return;
      state.closed = true;
      this.connections.delete(socket);
      this.queue = this.queue.filter(item => item.connection !== state);
      for (const leaseId of state.leaseIds) this.leases.delete(leaseId);
      this.scanQueue();
    };
    socket.on('close', cleanup);
    socket.on('error', () => {});
  }

  handleMessage(connection, message) {
    const requestId = message.requestId ?? message.id;
    if (message.type === 'acquire') {
      const mib = Number(message.mib);
      if (!Number.isInteger(mib) || mib <= 0) {
        return this.send(connection.socket, { type: 'error', requestId, error: 'mib must be a positive integer' });
      }
      const item = {
        requestId, mib,
        priority: Number.isInteger(message.priority) ? message.priority : 0,
        label: String(message.label ?? ''),
        enqueuedAt: Date.now(),
        sequence: this.sequence++,
        connection
      };
      this.queue.push(item);
      this.queue.sort((a, b) => b.priority - a.priority || a.sequence - b.sequence);
      connection.pending.add(requestId);
      this.scanQueue();
      return;
    }
    if (message.type === 'release') {
      const lease = this.leases.get(message.leaseId);
      if (lease?.connection === connection) {
        this.leases.delete(message.leaseId);
        connection.leaseIds.delete(message.leaseId);
      }
      this.send(connection.socket, { type: 'released', requestId, leaseId: message.leaseId });
      this.scanQueue();
      return;
    }
    if (message.type === 'cancel') {
      this.queue = this.queue.filter(item => !(item.connection === connection && item.requestId === message.targetRequestId));
      connection.pending.delete(message.targetRequestId);
      this.send(connection.socket, { type: 'cancelled', requestId });
      return;
    }
    if (message.type === 'status') {
      this.send(connection.socket, { type: 'status', requestId, ...this.status() });
      return;
    }
    this.send(connection.socket, { type: 'error', requestId, error: `unknown request type: ${message.type}` });
  }

  scanQueue() {
    while (this.queue.length) {
      const item = this.queue[0];
      if (item.connection.closed) {
        this.queue.shift();
        continue;
      }
      if (this.granted + this.external + item.mib + this.safety > this.physicalLimit) break;
      this.queue.shift();
      item.connection.pending.delete(item.requestId);
      const leaseId = `${process.pid}-${Date.now().toString(36)}-${(++this.leaseSequence).toString(36)}`;
      const lease = { leaseId, mib: item.mib, label: item.label, priority: item.priority, grantedAt: Date.now(), connection: item.connection };
      this.leases.set(leaseId, lease);
      item.connection.leaseIds.add(leaseId);
      this.send(item.connection.socket, { type: 'grant', requestId: item.requestId, leaseId, mib: item.mib });
    }
  }

  status() {
    return {
      budget: this.budget,
      reserve: this.reserve,
      safety: this.safety,
      live: { ...this.live, free: Math.max(0, this.live.total - this.live.used) },
      granted: this.granted,
      external: this.external,
      leases: [...this.leases.values()].map(({ connection, ...lease }) => lease),
      queue: this.queue.map(item => ({
        mib: item.mib, priority: item.priority, label: item.label,
        ageMs: Date.now() - item.enqueuedAt
      }))
    };
  }

  send(socket, message) {
    if (!socket.destroyed) socket.write(encodeMessage(message));
  }

  async close() {
    clearInterval(this.timer);
    this.timer = null;
    for (const socket of this.connections) socket.destroy();
    if (this.server) {
      await new Promise(resolve => this.server.close(resolve));
      this.server = null;
    }
    await unlink(this.socket).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

export async function createDaemon(options = {}) {
  const daemon = new VramgateDaemon(options);
  await daemon.start();
  return daemon;
}
