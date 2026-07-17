import { execFile } from 'node:child_process';

function systemQuery(index) {
  return new Promise((resolve, reject) => {
    execFile('nvidia-smi', [
      '--query-gpu=memory.used,memory.total',
      '--format=csv,noheader,nounits',
      '-i', String(index)
    ], { encoding: 'utf8' }, (error, stdout) => {
      if (error) return reject(error);
      const [used, total] = stdout.trim().split(/\s*,\s*/).map(Number);
      if (!Number.isFinite(used) || !Number.isFinite(total)) {
        return reject(new Error(`unexpected nvidia-smi output: ${stdout.trim()}`));
      }
      resolve({ used: Math.round(used), total: Math.round(total) });
    });
  });
}

export function createGpuQuery({ index = 0, queryFn = systemQuery, totalMib = 0, logger = console } = {}) {
  let cached;
  return async function queryGpu() {
    try {
      const value = await queryFn(index);
      const result = Array.isArray(value)
        ? { used: Number(value[0]), total: Number(value[1]) }
        : { used: Number(value.used), total: Number(value.total) };
      if (!Number.isFinite(result.used) || !Number.isFinite(result.total)) {
        throw new Error('GPU query returned invalid values');
      }
      cached = { used: Math.max(0, Math.round(result.used)), total: Math.max(0, Math.round(result.total)) };
      return cached;
    } catch (error) {
      logger?.warn?.(`vramgate: GPU query failed, using cached/bookkeeping values: ${error.message}`);
      return cached ?? { used: 0, total: Math.max(0, Math.round(totalMib)) };
    }
  };
}

export async function queryGpu(options = {}) {
  return createGpuQuery(options)();
}
