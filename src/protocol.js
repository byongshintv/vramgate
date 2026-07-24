export function encodeMessage(message) {
  return `${JSON.stringify(message)}\n`;
}

export function createDecoder(onMessage, onError = () => {}, options = {}) {
  const maxBytes = Number(options.maxBytes ?? 1024 * 1024);
  const onOverflow = options.onOverflow ?? (() => {});
  let buffer = '';
  let overflowed = false;
  return {
    push(chunk) {
      if (overflowed) return;
      buffer += chunk.toString('utf8');
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try {
          onMessage(JSON.parse(line));
        } catch (error) {
          onError(error, line);
        }
      }
      // A single message with no terminating newline must not grow without bound.
      if (Buffer.byteLength(buffer, 'utf8') > maxBytes) {
        overflowed = true;
        buffer = '';
        onOverflow(new Error(`message exceeds ${maxBytes} bytes without a newline`));
      }
    },
    get buffer() {
      return buffer;
    }
  };
}

export const createNdjsonDecoder = createDecoder;
