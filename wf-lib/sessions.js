// F4: reading Claude Code transcripts (<config>/projects/<folder>/<session>.jsonl). Pure: the
// caller reads the bytes (bin/sessions.mjs, in node; a mod never reads a transcript, since one
// can be tens of megabytes). A transcript only grows at its end, so counts are kept per file
// with the offset they were read up to, and only the new lines are read next time.

const PROMPT_SHOWN = 160;

// The text a person typed, from a parsed `user` record; null for everything else (tool results,
// skill bodies and other meta records, compaction summaries, sub-agent prompts, notifications).
// A slash command shows as itself: "/review".
export function promptText(rec) {
  if (rec?.type !== "user" || rec.isMeta || rec.isCompactSummary || rec.isSidechain) return null;
  const c = rec.message?.content;
  let text = typeof c === "string" ? c
    : Array.isArray(c) && !c.some(b => b?.type === "tool_result") ? c.filter(b => b?.type === "text").map(b => b.text).join("\n")
    : null;
  if (!text) return null;
  const command = text.match(/<command-name>([^<]*)<\/command-name>/);
  if (command) {
    const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim();
    return [command[1].trim(), args].filter(Boolean).join(" ").replace(/\s+/g, " ");
  }
  if (/^\s*<(task-notification|local-command-|system-reminder|bash-)/.test(text)) return null;
  text = text.replace(/<\/?pasted_content[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return text || null;
}

export const shortPrompt = text => (text && text.length > PROMPT_SHOWN ? `${text.slice(0, PROMPT_SHOWN - 1)}…` : text);

export const emptyCounts = () => ({ offset: 0, prompts: 0, compactions: 0, title: null, aiTitle: null, cwd: null });

// Adds the complete lines of `chunk` (text read from `counts.offset`) to the counts. Returns how
// many characters it used, up to the last newline: a line still being written is read next time.
// The caller moves `offset` by their size in bytes.
export function addLines(counts, chunk) {
  const end = chunk.lastIndexOf("\n");
  if (end < 0) return 0;
  for (const line of chunk.slice(0, end).split("\n")) {
    if (!line) continue;
    if (line.includes('"compact_boundary"')) { if (parse(line)?.subtype === "compact_boundary") counts.compactions++; continue; }
    if (line.includes('"type":"custom-title"')) { const r = parse(line); if (r?.type === "custom-title") counts.title = r.customTitle ?? counts.title; continue; }
    if (line.includes('"type":"ai-title"')) { const r = parse(line); if (r?.type === "ai-title") counts.aiTitle = r.aiTitle ?? counts.aiTitle; continue; }
    // Tool results are most of the bytes and never a prompt: an unescaped "tool_use_id" key.
    if (!line.includes('"type":"user"') || line.includes('"tool_use_id"')) continue;
    const rec = parse(line);
    if (!counts.cwd && rec?.cwd) counts.cwd = rec.cwd;
    if (promptText(rec)) counts.prompts++;
  }
  return end + 1;
}

// The first prompt in the head of a transcript, or null when the head holds none yet.
export function firstPrompt(head) {
  for (const line of head.split("\n")) {
    if (!line.includes('"type":"user"')) continue;
    const text = promptText(parse(line));
    if (text) return text;
  }
  return null;
}

// Claude's last answer: the text of the last main-thread assistant record in the tail, or null.
export function lastAnswer(tail) {
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"type":"assistant"')) continue;
    const rec = parse(lines[i]);
    if (!rec || rec.isSidechain || rec.type !== "assistant") continue;
    const text = (rec.message?.content ?? []).filter(b => b?.type === "text").map(b => b.text).join("\n").trim();
    if (text) return text;
  }
  return null;
}

export const sessionTitle = (counts, prompt) => counts.title ?? counts.aiTitle ?? shortPrompt(prompt) ?? "(no prompt yet)";

function parse(line) {
  try { return JSON.parse(line); } catch { return null; }
}
