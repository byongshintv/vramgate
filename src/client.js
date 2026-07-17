import net from 'node:net';
import { defaultSocketPath } from './daemon.js';
import { createDecoder, encodeMessage } from './protocol.js';

function preemptibleLeaseFields() {
  let resolvePreempted;
  const callbacks = new Set();
  const preempted = new Promise(resolve => { resolvePreempted = resolve; });
  return {
    callbacks,
    preempted,
    trigger(message) {
      resolvePreempted(message);
      for (const callback of callbacks) callback(message);
      callbacks.clear();
    }
  };
}

function noopLease(mib) {
  const preemption = preemptibleLeaseFields();
  return {
    leaseId: null, mib, noop: true, preempted: preemption.preempted,
    onPreempt(callback) {
      preemption.callbacks.add(callback);
      return () => preemption.callbacks.delete(callback);
    },
    async release() {}
  };
}

export class VramBusyError extends Error {
  constructor(message = 'VRAM lease acquisition timed out') {
    super(message);
    this.name = 'VramBusyError';
    this.code = 'VRAM_BUSY';
  }
}

export class VramgateClient {
  constructor({ socket = defaultSocketPath(), failOpen = true } = {}) {
    this.socketPath = socket;
    this.failOpen = failOpen;
    this.socket = null;
    this.connectPromise = null;
    this.pending = new Map();
    this.leases = new Map();
    this.nextId = 1;
  }

  async connect() {
    if (this.socket && !this.socket.destroyed) return this;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      let settled = false;
      const decoder = createDecoder(
        message => this.onMessage(message),
        error => this.failAll(error)
      );
      socket.setEncoding('utf8');
      socket.on('data', chunk => decoder.push(chunk));
      socket.once('connect', () => {
        settled = true;
        this.socket = socket;
        resolve(this);
      });
      socket.once('error', error => {
        if (!settled) reject(error);
        else this.failAll(error);
      });
      socket.once('close', () => {
        if (this.socket === socket) this.socket = null;
        this.failAll(new Error('vramgate connection closed'));
      });
    }).finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  onMessage(message) {
    if (message.type === 'preempt') {
      this.leases.get(message.leaseId)?.trigger(message);
      return;
    }
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    if (message.type === 'error') {
      this.pending.delete(message.requestId);
      pending.reject(new Error(message.error));
    } else if (pending.types.has(message.type)) {
      this.pending.delete(message.requestId);
      pending.resolve(message);
    }
  }

  failAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  async request(message, types) {
    await this.connect();
    const requestId = this.nextId++;
    const response = new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject, types: new Set(types) });
    });
    this.socket.write(encodeMessage({ ...message, requestId }));
    return { requestId, response };
  }

  async acquire(mib, { priority, label = '', timeoutMs = 0, preemptible = false, adopt = false, idleWindowMs = 0 } = {}) {
    mib = Number(mib);
    if (!Number.isInteger(mib) || mib <= 0) throw new TypeError('mib must be a positive integer');
    priority = priority == null ? (preemptible ? -100 : 0) : Number(priority);
    let operation;
    try {
      operation = await this.request({
        type: 'acquire', mib, priority, label,
        preemptible: Boolean(preemptible),
        adopt: Boolean(adopt),
        idleWindowMs: Number(idleWindowMs)
      }, ['grant']);
    } catch (error) {
      if (this.failOpen) return noopLease(mib);
      throw error;
    }
    let timer;
    try {
      const message = timeoutMs > 0
        ? await Promise.race([
            operation.response,
            new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(new VramBusyError(`VRAM lease acquisition timed out after ${timeoutMs}ms`)),
                timeoutMs
              );
            })
          ])
        : await operation.response;
      const preemption = preemptibleLeaseFields();
      const lease = {
        leaseId: message.leaseId,
        mib: message.mib,
        noop: false,
        preemptible: Boolean(message.preemptible),
        preempted: preemption.preempted,
        onPreempt(callback) {
          preemption.callbacks.add(callback);
          return () => preemption.callbacks.delete(callback);
        },
        release: async () => {
          if (!lease.leaseId) return;
          const leaseId = lease.leaseId;
          lease.leaseId = null;
          this.leases.delete(leaseId);
          const { response } = await this.request({ type: 'release', leaseId }, ['released']);
          await response;
        }
      };
      preemption.trigger = preemption.trigger.bind(preemption);
      this.leases.set(lease.leaseId, preemption);
      return lease;
    } catch (error) {
      this.pending.delete(operation.requestId);
      if (this.socket && !this.socket.destroyed) {
        this.socket.write(encodeMessage({ type: 'cancel', requestId: this.nextId++, targetRequestId: operation.requestId }));
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async status() {
    const { response } = await this.request({ type: 'status' }, ['status']);
    return response;
  }

  async withLease(mib, opts, fn) {
    if (typeof opts === 'function') {
      fn = opts;
      opts = {};
    }
    const lease = await this.acquire(mib, opts);
    try {
      return await fn(lease);
    } finally {
      await lease.release();
    }
  }

  close() {
    this.socket?.end();
    this.socket = null;
  }
}

export default VramgateClient;
