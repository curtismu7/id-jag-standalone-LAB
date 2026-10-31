// In-memory ring buffer of trace events, newest first.
// A throwing subscriber never breaks push() or starves later subscribers; its error
// goes to onError(err, event) (default: ignored). Event contents are never logged here.
export function createSink({ size = 500, onError = () => {} } = {}) {
  if (!Number.isInteger(size) || size < 1) throw new Error('size must be a positive integer');
  const items = []; // oldest first internally
  const subs = new Set();
  return {
    push(event) {
      items.push(event);
      if (items.length > size) items.shift();
      for (const fn of [...subs]) {
        try {
          fn(event);
        } catch (err) {
          try { onError(err, event); } catch { /* a failing error handler must not break the hop */ }
        }
      }
    },
    list({ trace_id } = {}) {
      const out = items.slice().reverse();
      return trace_id ? out.filter((e) => e.trace_id === trace_id) : out;
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    clear() {
      items.length = 0;
    },
  };
}
