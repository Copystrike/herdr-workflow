// F12 local telemetry: track(event, fields) appends one JSON line per event to
// <appHome>/data/wf/telemetry/<yyyy-mm-dd>.jsonl. Local only, no content: only whitelisted
// fields, and string values must be short identifiers. Schema in docs/schema.md.

export const TELEMETRY_VERSION = 1;

// Every field an event may carry. Anything else is dropped before writing.
export const FIELDS = new Set([
  "mod", "version", "error", "ms", "cmd", "exit", "bytes", "surface", "action", "repo", "branch",
  "phase_from", "phase_to", "command", "terminal", "session", "status", "pattern", "phase", "count", "group",
]);

const MAX_STRING = 120;
const MAX_FILE = 900 * 1024; // readTextFile caps at 1 MiB: roll over before that

// Keeps whitelisted fields with number, boolean or short single-line string values.
export function clean(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields ?? {})) {
    if (!FIELDS.has(k) || v == null) continue;
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (typeof v === "boolean") out[k] = v;
    else if (typeof v === "string" && v.length <= MAX_STRING && !/[\n\r]/.test(v)) out[k] = v;
  }
  return out;
}

export const line = (event, fields, now = new Date()) =>
  JSON.stringify({ v: TELEMETRY_VERSION, ts: now.toISOString(), event: String(event).slice(0, 60), ...clean(fields) });

// Files are named by the local date: a day of work stays in one file.
const pad = n => String(n).padStart(2, "0");
const day = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// A batching writer. io: { readTextFile(path), writeTextFile(path, text, expected), enabled() }.
// Mods call flush() from a cx.timer; nothing is written while enabled() is false.
export function createTracker(dir, io) {
  let queue = [];
  let flushing = false;
  return {
    track(event, fields) {
      if (io.enabled && !io.enabled()) return;
      queue.push(line(event, fields));
      if (queue.length > 500) queue = queue.slice(-500);
    },
    pending: () => queue.length,
    async flush(now = new Date()) {
      if (flushing || !queue.length) return 0;
      if (io.enabled && !io.enabled()) { queue = []; return 0; }
      flushing = true;
      const batch = queue;
      queue = [];
      try {
        let part = 0, conflicts = 0;
        while (part < 50 && conflicts < 3) {
          const path = `${dir}/${day(now)}${part ? "." + part : ""}.jsonl`;
          const old = await io.readTextFile(path);
          if (old && old.length > MAX_FILE) { part++; continue; }
          const text = (old ?? "") + batch.join("\n") + "\n";
          try { await io.writeTextFile(path, text, old); return batch.length; }
          catch { conflicts++; } // another writer won the compare-and-set: read the same part again
        }
        queue = batch.concat(queue);
        return 0;
      } finally { flushing = false; }
    },
  };
}
