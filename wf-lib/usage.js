// Pure Claude/agent usage tracker logic for the Herdr footer & details popover:
//   - Parses Claude Code statusLine JSON payloads (context_window, rate_limits, cost)
//   - Maintains a lightweight store of global 5h/7d rate limits + per-session context & cost
//   - Formats compact token counts (162k / 1M), reset times (12:00 PM / Thu 04:00 PM), and USD
// No herdr or node-only imports so it runs in both GPUI mods and node --test.

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function finiteNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function parseClaudeStatusPayload(raw) {
  let d = raw;
  if (typeof raw === "string") {
    try { d = JSON.parse(raw); } catch { return null; }
  }
  if (!d || typeof d !== "object") return null;

  const cw = d.context_window && typeof d.context_window === "object" ? d.context_window : null;
  let ctxUsed = null;
  let ctxSize = null;
  if (cw) {
    ctxSize = finiteNum(cw.context_window_size ?? cw.displayed_context_limit);
    const cu = cw.current_usage && typeof cw.current_usage === "object" ? cw.current_usage : null;
    if (cu) {
      const sum = (finiteNum(cu.input_tokens) || 0)
        + (finiteNum(cu.cache_creation_input_tokens) || 0)
        + (finiteNum(cu.cache_read_input_tokens) || 0);
      if (sum > 0) ctxUsed = sum;
    }
    if (ctxUsed == null) {
      const direct = finiteNum(cw.current_context_tokens ?? cw.context_tokens ?? cw.total_input_tokens);
      if (direct != null && direct > 0) ctxUsed = direct;
    }
  }
  const ctxPct = ctxUsed != null && ctxSize != null && ctxSize > 0
    ? Math.max(0, Math.min(100, Math.round((ctxUsed / ctxSize) * 100)))
    : (cw && finiteNum(cw.used_percentage) != null ? Math.round(Number(cw.used_percentage)) : null);

  const rl = d.rate_limits && typeof d.rate_limits === "object" ? d.rate_limits : null;
  const parseWindow = w => {
    if (!w || typeof w !== "object") return null;
    const pct = finiteNum(w.used_percentage);
    const resetsAt = finiteNum(w.resets_at);
    if (pct == null && resetsAt == null) return null;
    return {
      pct: pct != null ? Math.max(0, Math.min(100, Math.round(pct))) : null,
      resetsAt: resetsAt != null ? Math.floor(resetsAt) : null,
    };
  };
  const fiveHour = parseWindow(rl?.five_hour);
  const sevenDay = parseWindow(rl?.seven_day);

  const costUsd = finiteNum(d.cost?.total_cost_usd ?? d.total_cost_usd);
  const model = typeof d.model === "string"
    ? d.model
    : (d.model?.display_name || d.model?.id || null);

  if (ctxPct == null && !fiveHour && !sevenDay && costUsd == null) return null;

  return {
    agent: "claude",
    sessionId: typeof d.session_id === "string" && d.session_id ? d.session_id : null,
    cwd: typeof d.cwd === "string" && d.cwd ? d.cwd : (typeof d.workspace?.current_dir === "string" ? d.workspace.current_dir : null),
    model,
    context: ctxPct != null ? { used: ctxUsed, size: ctxSize, pct: ctxPct } : null,
    fiveHour,
    sevenDay,
    costUsd,
  };
}

export function mergeUsageStore(prev, sample, nowMs = Date.now()) {
  const base = prev && typeof prev === "object" ? prev : {};
  const sessions = { ...(base.sessions && typeof base.sessions === "object" ? base.sessions : {}) };

  // Prune stale sessions older than 7 days
  for (const [k, v] of Object.entries(sessions)) {
    if (!v || (nowMs - (v.updatedAt || 0)) > SEVEN_DAYS_MS) delete sessions[k];
  }

  if (sample) {
    const key = sample.sessionId || sample.cwd || "default";
    const old = sessions[key] || {};
    sessions[key] = {
      sessionId: sample.sessionId || old.sessionId || null,
      cwd: sample.cwd || old.cwd || null,
      model: sample.model || old.model || null,
      ctxUsed: sample.context?.used ?? old.ctxUsed ?? null,
      ctxSize: sample.context?.size ?? old.ctxSize ?? null,
      ctxPct: sample.context?.pct ?? old.ctxPct ?? null,
      costUsd: sample.costUsd != null ? Math.max(old.costUsd || 0, sample.costUsd) : (old.costUsd ?? 0),
      updatedAt: nowMs,
    };
  }

  const totalCostUsd = Object.values(sessions).reduce((sum, s) => sum + (Number(s?.costUsd) || 0), 0);

  return {
    version: 1,
    agent: sample?.agent || base.agent || "claude",
    updatedAt: nowMs,
    fiveHour: sample?.fiveHour ? { ...sample.fiveHour, updatedAt: nowMs } : (base.fiveHour || null),
    sevenDay: sample?.sevenDay ? { ...sample.sevenDay, updatedAt: nowMs } : (base.sevenDay || null),
    totalCostUsd: Math.round(totalCostUsd * 100) / 100,
    sessions,
  };
}

export function selectActiveContext(store, cwd) {
  const list = Object.values(store?.sessions || {}).filter(s => s && s.ctxPct != null);
  if (!list.length) return null;
  list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  if (cwd) {
    const exact = list.find(s => s.cwd === cwd);
    if (exact) return exact;
  }
  return list[0];
}

export function formatTokensCompact(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return "";
  if (v >= 1_000_000) {
    const m = v / 1_000_000;
    return `${m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)}M`;
  }
  if (v >= 1_000) return `${Math.round(v / 1_000)}k`;
  return String(Math.round(v));
}

export function formatResetTime(epochSec, { showDay = false } = {}) {
  const sec = Number(epochSec);
  if (!Number.isFinite(sec) || sec <= 0) return "";
  const d = new Date(sec * 1000);
  if (Number.isNaN(d.getTime())) return "";
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const h24 = d.getHours();
  const ampm = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const mm = String(d.getMinutes()).padStart(2, "0");
  const hh = showDay ? String(h12).padStart(2, "0") : String(h12);
  return showDay ? `resets ${days[d.getDay()]} ${hh}:${mm} ${ampm}` : `resets ${hh}:${mm} ${ampm}`;
}

export function formatUsd(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return "$0";
  if (n >= 100) return `$${Math.round(n)}`;
  if (n >= 10) return `$${n.toFixed(1).replace(/\.0$/, "")}`;
  return `$${n.toFixed(2)}`;
}
