export function parseMib(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
      throw new TypeError(`invalid MiB value: ${value}`);
    }
    return value;
  }
  if (typeof value !== 'string') throw new TypeError('memory size must be a number or string');
  const match = value.trim().match(/^(\d+)\s*([gGmM])?$/);
  if (!match) throw new TypeError(`invalid memory size: ${value}`);
  const amount = Number(match[1]);
  const mib = match[2]?.toLowerCase() === 'g' ? amount * 1024 : amount;
  if (!Number.isSafeInteger(mib)) throw new RangeError(`memory size is too large: ${value}`);
  return mib;
}

export const parseMemory = parseMib;

export function parseDurationMs(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) throw new TypeError(`invalid duration: ${value}`);
    return value;
  }
  if (typeof value !== 'string') throw new TypeError('duration must be a number or string');
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i);
  if (!match) throw new TypeError(`invalid duration: ${value}`);
  const multiplier = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[(match[2] ?? 's').toLowerCase()];
  const milliseconds = Number(match[1]) * multiplier;
  if (!Number.isSafeInteger(milliseconds)) throw new RangeError(`duration is too large or too precise: ${value}`);
  return milliseconds;
}
