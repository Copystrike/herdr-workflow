import test from "node:test";
import assert from "node:assert/strict";
import {
  parseClaudeStatusPayload,
  mergeUsageStore,
  selectActiveContext,
  formatTokensCompact,
  formatResetTime,
  formatUsd,
} from "../wf-lib/usage.js";

test("usage: parses Claude statusLine payload with context, 5h/7d rate limits, and cost", () => {
  const sample = parseClaudeStatusPayload({
    session_id: "sess-1",
    cwd: "/tmp/repo",
    model: { id: "claude-opus-4-6", display_name: "Opus 4.6" },
    context_window: {
      context_window_size: 1000000,
      current_usage: { input_tokens: 2000, cache_creation_input_tokens: 10000, cache_read_input_tokens: 150000 },
    },
    rate_limits: {
      five_hour: { used_percentage: 17.4, resets_at: 1795431600 },
      seven_day: { used_percentage: 19.2, resets_at: 1795964400 },
    },
    cost: { total_cost_usd: 12.45 },
  });
  assert.equal(sample.context.used, 162000);
  assert.equal(sample.context.size, 1000000);
  assert.equal(sample.context.pct, 16);
  assert.equal(sample.fiveHour.pct, 17);
  assert.equal(sample.sevenDay.pct, 19);
  assert.equal(sample.costUsd, 12.45);
  assert.equal(sample.model, "Opus 4.6");
});

test("usage: merges multiple sessions, sums cost, and selects active cwd context", () => {
  const t1 = 1_700_000_000_000;
  let store = mergeUsageStore(null, {
    agent: "claude", sessionId: "s1", cwd: "/repo/a", model: "Sonnet",
    context: { used: 50000, size: 200000, pct: 25 },
    fiveHour: { pct: 10, resetsAt: 1700010000 },
    sevenDay: { pct: 15, resetsAt: 1700500000 },
    costUsd: 4.5,
  }, t1);
  store = mergeUsageStore(store, {
    agent: "claude", sessionId: "s2", cwd: "/repo/b", model: "Opus",
    context: { used: 162000, size: 1000000, pct: 16 },
    fiveHour: null,
    sevenDay: null,
    costUsd: 10.25,
  }, t1 + 5000);

  assert.equal(store.fiveHour.pct, 10);
  assert.equal(store.sevenDay.pct, 15);
  assert.equal(store.totalCostUsd, 14.75);
  assert.equal(selectActiveContext(store, "/repo/a").ctxPct, 25);
  assert.equal(selectActiveContext(store, "/repo/b").ctxPct, 16);
  assert.equal(selectActiveContext(store, "/repo/unknown").ctxPct, 16);
});

test("usage: formats compact tokens, USD, and reset timestamps", () => {
  assert.equal(formatTokensCompact(162000), "162k");
  assert.equal(formatTokensCompact(1000000), "1M");
  assert.equal(formatUsd(234.4), "$234");
  assert.equal(formatUsd(12.4), "$12.4");
  assert.equal(formatUsd(0.85), "$0.85");
  assert.match(formatResetTime(1795431600, { showDay: false }), /^resets \d{1,2}:\d{2} (AM|PM)$/);
  assert.match(formatResetTime(1795431600, { showDay: true }), /^resets (Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d{2}:\d{2} (AM|PM)$/);
});
