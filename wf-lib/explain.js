// Pure logic for CodeRabbit-style local "Explain / Change Stack" reviews:
//   - Per-file patch-hash diffing for zero-waste incremental updates
//   - Structured JSON schema for Claude (-p --json-schema), Codex, and Gemini
//   - Deterministic merge preserving resolved findings & unchanged file analyses
//   - Overview KPIs & severity rollups for the wf-explain GPUI mod
// No herdr or node-only imports here so it runs identically in mods and under node --test.

export const SEVERITY_ORDER = ["critical", "major", "minor", "nit"];

export const EXPLAIN_ENGINES = [
  { id: "claude", label: "Claude", defaultModel: "" },
  { id: "codex", label: "Codex", defaultModel: "" },
  { id: "gemini", label: "Gemini", defaultModel: "" },
];

const FINDING_ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["file", "lineStart", "lineEnd", "severity", "category", "title", "impact", "body", "suggestion"],
  properties: {
    file: { type: "string" },
    lineStart: { type: "integer" },
    lineEnd: { type: "integer" },
    severity: { type: "string", enum: ["critical", "major", "minor", "nit"] },
    category: { type: "string", enum: ["security", "bug", "logic", "performance", "maintainability", "testing"] },
    title: { type: "string", description: "Short 4-9 word headline stating the problem in plain English." },
    impact: { type: "string", description: "One short sentence (max 14 words): what actually breaks or goes wrong if shipped as-is." },
    body: { type: "string", description: "Concise 1-2 sentence explanation of why it happens and how to fix it (shown only when expanded)." },
    suggestion: { type: "string", description: "Short code fix snippet if helpful, else empty string." },
  },
};

export const BUG_HUNT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      description: "Verified production bugs, security holes, race conditions, or broken edge cases found during deep audit.",
      items: FINDING_ITEM_SCHEMA,
    },
  },
};

export const ASK_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["tldr", "bullets", "snippets"],
  properties: {
    tldr: { type: "string", description: "One crisp direct answer sentence (max 18 words). Supports **bold** and `code`." },
    bullets: {
      type: "array",
      description: "0-4 ultra-short scannable bullets (max 14 words each). Supports **bold** and `code`.",
      items: { type: "string" },
    },
    snippets: {
      type: "array",
      description: "0-2 real code references (exact repo-relative path + 1-based line range, max 10 lines each) that prove the answer.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["file", "lineStart", "lineEnd", "caption"],
        properties: {
          file: { type: "string", description: "Repo-relative file path." },
          lineStart: { type: "integer" },
          lineEnd: { type: "integer" },
          caption: { type: "string", description: "Short 3-8 word label for what this snippet shows." },
        },
      },
    },
  },
};

// Lightweight inline markdown parser for **bold** and `code` spans (used in Q&A, findings, and summaries).
export function parseInlineMarkdown(text) {
  const s = String(text || "");
  if (!s) return [];
  const out = [];
  const re = /`([^`\n]+)`|\*\*([^*\n]+)\*\*/g;
  let last = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) out.push({ kind: "text", text: s.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ kind: "code", text: m[1] });
    else if (m[2] !== undefined) out.push({ kind: "bold", text: m[2] });
    last = re.lastIndex;
  }
  if (last < s.length) out.push({ kind: "text", text: s.slice(last) });
  return out;
}

export const EXPLAIN_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "tldr", "story", "bullets", "summary", "uiChanges", "intentCheck", "diagram", "layers", "fileSummaries", "findings"],
  properties: {
    title: { type: "string", description: "Short plain-English headline (4-8 words) describing the outcome for users/product. No file or method names." },
    tldr: { type: "string", description: "One crisp plain-English sentence (max 18 words) explaining what this branch accomplishes." },
    story: {
      type: "object",
      additionalProperties: false,
      required: ["pitch", "before", "after", "example"],
      properties: {
        pitch: { type: "string", description: "Polished, crystal-clear 1-2 sentence product release pitch ('PR statement') explaining why this feature exists and what it unlocks for users/team. Zero code jargon." },
        before: { type: "string", description: "One short factual sentence (max 16 words) stating how it worked BEFORE this branch (the old hardcoded/missing/broken behavior from the diff)." },
        after: { type: "string", description: "One short factual sentence (max 16 words) stating how it works NOW in direct contrast to `before`." },
        example: { type: "string", description: "Optional 1-line concrete real-world example with real numbers or user flow (max 18 words). Empty string if not applicable." },
      },
    },
    bullets: {
      type: "array",
      description: "2-4 ultra-short scannable bullets summarizing the branch in plain English. Avoid class/method/endpoint jargon.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["lead", "text"],
        properties: {
          lead: { type: "string", description: "2-4 word bold label (e.g. 'Cart checkout', 'Invoice memo', 'API & tests')." },
          text: { type: "string", description: "One short plain-English phrase (max 14 words) explaining the outcome." },
        },
      },
    },
    summary: { type: "string", description: "Short 1-sentence fallback summary (max 20 words)." },
    uiChanges: {
      type: "array",
      description: "Customer/team-demo-ready list of visible UI changes (new buttons, fields, columns, labels, screens, or interactions). Empty array [] if no user-facing UI changed.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["screen", "change", "detail"],
        properties: {
          screen: { type: "string", description: "Where in the app the user sees this (e.g. 'Admin -> Subscriptions tab', 'Checkout modal')." },
          change: { type: "string", description: "Short plain-language headline of what is new or visibly different (max 12 words, zero code jargon)." },
          detail: { type: "string", description: "One short sentence explaining what happens when a user clicks/types/views it (max 16 words)." },
        },
      },
    },
    intentCheck: {
      type: "object",
      additionalProperties: false,
      required: ["status", "summary", "gaps"],
      properties: {
        status: { type: "string", enum: ["aligned", "partial", "mismatch", "none"] },
        summary: { type: "string", description: "One crisp sentence comparing the diff against the PR/issue goal. Empty string if status is 'none'." },
        gaps: {
          type: "array",
          description: "Specific missed requirements or unexpected scope changes compared to the PR/issue. Empty array if aligned or none.",
          items: { type: "string" },
        },
      },
    },
    diagram: {
      type: "object",
      additionalProperties: false,
      required: ["caption", "nodes", "edges"],
      properties: {
        caption: { type: "string", description: "Short 1-line plain-language summary of how the pieces connect (e.g. 'How discount rules reach the checkout screen'). Empty if only 1 isolated area changed." },
        nodes: {
          type: "array",
          description: "3-5 plain-language components showing where this change lives (Database, Backend, Endpoint, Screen, Infra, External). Include whenever a branch connects 2+ areas so a high-level reviewer immediately sees e.g. 'DB data wired into Admin screen'. Leave empty for tiny single-file tweaks.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "label", "kind", "changed", "layerId"],
            properties: {
              id: { type: "string" },
              label: { type: "string", description: "Short 2-4 word plain-language label (e.g. 'Admin billing screen', 'Cart pricing logic')." },
              kind: { type: "string", enum: ["ui", "api", "service", "data", "infra", "external"] },
              changed: { type: "boolean", description: "True if modified or added by this branch." },
              layerId: { type: "string", description: "Matching layer id from `layers` so clicking this piece opens its changes, else empty string." },
            },
          },
        },
        edges: {
          type: "array",
          description: "3-5 clear connections showing what flows between the components above.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["from", "to", "label"],
            properties: {
              from: { type: "string" },
              to: { type: "string" },
              label: { type: "string", description: "Short 2-5 word plain-language description of what passes between them." },
            },
          },
        },
      },
    },
    layers: {
      type: "array",
      description: "Logical review layers ordered from foundations to consumers.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "title", "summary", "dependsOn", "files"],
        properties: {
          id: { type: "string" },
          title: { type: "string", description: "Short human label (3-6 words, no method names)." },
          summary: { type: "string", description: "One short plain-English line (max 14 words). No symbol-name soup." },
          dependsOn: { type: "array", items: { type: "string" } },
          files: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["path", "role"],
              properties: {
                path: { type: "string" },
                role: { type: "string", description: "Short 6-12 word plain-English note on what changed in this file." },
              },
            },
          },
        },
      },
    },
    fileSummaries: {
      type: "array",
      description: "Short plain-English one-liner (max 12 words) for each newly analyzed file.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "summary"],
        properties: {
          path: { type: "string" },
          summary: { type: "string" },
        },
      },
    },
    findings: {
      type: "array",
      description: "Only genuinely important verified bugs, security risks, or edge cases. Skip minor nits.",
      items: FINDING_ITEM_SCHEMA,
    },
  },
};

export function normalizeExplainConfig(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const engine = ["claude", "codex", "gemini"].includes(src.engine) ? src.engine : "claude";
  const model = typeof src.model === "string" ? src.model.trim() : "";
  const effort = ["low", "medium", "high"].includes(src.effort) ? src.effort : "medium";
  const language = typeof src.language === "string" && src.language.trim() ? src.language.trim() : "English";
  const rawMin = src.bugHuntMinFiles;
  const parsedMin = rawMin === undefined || rawMin === null || rawMin === "" ? 12 : Number(rawMin);
  const bugHuntMinFiles = Number.isFinite(parsedMin) ? Math.max(0, Math.min(200, Math.floor(parsedMin))) : 12;
  return { engine, model, effort, language, bugHuntMinFiles };
}

// Filters out tests, snapshots, lockfiles, docs, and generated files so Pass 2 bug-hunt focuses on real prod/infra code.
export function isNonProductionFile(filePath) {
  const p = String(filePath || "").replace(/\\/g, "/");
  if (!p) return true;
  const lower = p.toLowerCase();
  const base = lower.split("/").pop() || "";

  // Test directories & files
  if (/(^|\/)(__tests__|__mocks__|test|tests|spec|specs|e2e|cypress|playwright|fixtures|testdata)(\/|$)/.test(lower)) return true;
  if (/(^|\/)[^/]*\.(tests?|specs?|systemtests?|integrationtests?|unittests?)\//.test(lower)) return true;
  if (/\.(test|spec|stories|story)\.[a-z0-9]+$/.test(base)) return true;
  if (/_test\.[a-z0-9]+$/.test(base)) return true;
  if (/(tests?|spec)\.(cs|java|kt|py|rb|php)$/.test(base)) return true;

  // Lockfiles, snapshots, generated code, docs, static assets
  if (/^(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|flake\.lock|cargo\.lock|composer\.lock|poetry\.lock|gemfile\.lock|packages\.lock\.json)$/.test(base)) return true;
  if (/\.(snap|snapshot|min\.js|min\.css|map|g\.cs|designer\.cs|generated\.[a-z0-9]+|pb\.[a-z0-9]+|d\.ts)$/.test(base)) return true;
  if (/\.(md|mdx|txt|rst|adoc|svg|png|jpg|jpeg|gif|webp|ico|woff2?|ttf|eot|pdf)$/.test(base)) return true;
  if (/^(license|copying|changelog|notice|authors|codeowners)(\..+)?$/.test(base)) return true;

  return false;
}

export function filterBugHuntFiles(files) {
  return (Array.isArray(files) ? files : []).filter(f => f && !f.binary && !isNonProductionFile(f.path));
}

// Topological left-to-right column layout for architecture diagrams (cycle-safe).
export function layoutDiagram(diagram) {
  const rawNodes = Array.isArray(diagram?.nodes) ? diagram.nodes : [];
  const rawEdges = Array.isArray(diagram?.edges) ? diagram.edges : [];
  const validIds = new Set();
  const nodes = [];
  for (const n of rawNodes) {
    const id = String(n?.id || "").trim();
    const label = String(n?.label || "").trim();
    if (!id || !label || validIds.has(id)) continue;
    validIds.add(id);
    const kind = ["ui", "api", "service", "data", "infra", "external"].includes(n.kind) ? n.kind : "service";
    nodes.push({ id, label, kind, changed: Boolean(n.changed), layerId: String(n.layerId || "").trim() });
  }
  if (nodes.length < 2) return null;

  const edges = [];
  const incoming = new Map(nodes.map(n => [n.id, 0]));
  const outgoing = new Map(nodes.map(n => [n.id, []]));
  for (const e of rawEdges) {
    const from = String(e?.from || "").trim();
    const to = String(e?.to || "").trim();
    if (!from || !to || from === to || !validIds.has(from) || !validIds.has(to)) continue;
    edges.push({ from, to, label: String(e?.label || "").trim() });
    outgoing.get(from).push(to);
    incoming.set(to, (incoming.get(to) || 0) + 1);
  }

  // Assign columns via BFS topological depth (cap depth to avoid cycles)
  const depth = new Map();
  const queue = [];
  for (const n of nodes) {
    if ((incoming.get(n.id) || 0) === 0) {
      depth.set(n.id, 0);
      queue.push(n.id);
    }
  }
  if (!queue.length) {
    depth.set(nodes[0].id, 0);
    queue.push(nodes[0].id);
  }
  const maxDepth = Math.min(4, nodes.length - 1);
  let guard = 0;
  while (queue.length && guard < 128) {
    guard++;
    const cur = queue.shift();
    const d = depth.get(cur) || 0;
    for (const nxt of outgoing.get(cur) || []) {
      const nextD = Math.min(maxDepth, d + 1);
      if (!depth.has(nxt) || depth.get(nxt) < nextD) {
        depth.set(nxt, nextD);
        queue.push(nxt);
      }
    }
  }
  for (const n of nodes) {
    if (!depth.has(n.id)) depth.set(n.id, 0);
  }

  const colMap = new Map();
  for (const n of nodes) {
    const c = depth.get(n.id) || 0;
    if (!colMap.has(c)) colMap.set(c, []);
    colMap.get(c).push(n);
  }
  const columns = [...colMap.keys()].sort((a, b) => a - b).map(k => colMap.get(k));
  const nodeById = new Map(nodes.map(n => [n.id, n]));
  return {
    caption: String(diagram?.caption || "").trim(),
    nodes,
    edges,
    columns,
    nodeById,
  };
}

export function addExplainLanguage(existingList, rawLang) {
  const clean = String(rawLang || "").trim().replace(/\s+/g, " ").slice(0, 40);
  const base = Array.isArray(existingList) && existingList.length
    ? existingList.map(x => String(x || "").trim()).filter(Boolean)
    : ["English"];
  const list = [];
  const seen = new Set();
  for (const item of base) {
    const k = item.toLowerCase();
    if (!seen.has(k)) { seen.add(k); list.push(item); }
  }
  if (!clean) return { list, selected: list[0] || "English" };
  const key = clean.toLowerCase();
  const match = list.find(x => x.toLowerCase() === key);
  if (match) return { list, selected: match };
  list.push(clean);
  return { list, selected: clean };
}

export function normalizeSeverity(sev) {
  const s = String(sev || "").toLowerCase().trim();
  if (SEVERITY_ORDER.includes(s)) return s;
  if (s === "high" || s === "blocker" || s === "error") return "critical";
  if (s === "medium" || s === "warning" || s === "warn") return "major";
  if (s === "low" || s === "info") return "minor";
  return "minor";
}

// Deterministic lightweight string hash (FNV-1a 32-bit hex) so finding IDs are stable across mods & Node.
export function stableHash(text) {
  let h = 0x811c9dc5;
  const s = String(text || "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function findingIdFor(f) {
  return `f-${stableHash(`${f.file}|${f.lineStart}|${f.severity}|${String(f.title || "").slice(0, 64)}`)}`;
}

// Deterministic fingerprint of the branch's current file diffs so Q&As know when code changed underneath them.
export function branchStateHash(filesOrMap) {
  if (!filesOrMap) return "";
  const entries = Array.isArray(filesOrMap)
    ? filesOrMap.map(f => `${f.path}:${f.patchHash || ""}`)
    : Object.entries(filesOrMap).map(([p, f]) => `${p}:${f?.patchHash || ""}`);
  if (!entries.length) return "empty";
  entries.sort();
  return stableHash(entries.join("\n"));
}

// Partitions current branch files against a cached review using per-file patch hashes.
export function diffPatchState(currentFiles, cachedReview) {
  const files = Array.isArray(currentFiles) ? currentFiles : [];
  const cachedMap = cachedReview?.files && typeof cachedReview.files === "object" ? cachedReview.files : {};
  const curByPath = new Map(files.map(f => [f.path, f]));

  const unchanged = [];
  const added = [];
  const modified = [];
  const removed = [];

  for (const f of files) {
    const prev = cachedMap[f.path];
    if (!prev) {
      added.push(f);
    } else if (prev.patchHash && f.patchHash && prev.patchHash === f.patchHash) {
      unchanged.push(f);
    } else {
      modified.push(f);
    }
  }

  for (const oldPath of Object.keys(cachedMap)) {
    if (!curByPath.has(oldPath)) removed.push(oldPath);
  }

  const changed = [...added, ...modified];
  return {
    unchanged,
    added,
    modified,
    changed,
    removed,
    hasChanges: changed.length > 0 || removed.length > 0 || !cachedReview,
    staleCount: changed.length + removed.length,
  };
}

// Builds either a full Change Stack prompt or a minimal incremental delta prompt.
export function buildExplainPrompt({
  branch,
  baseRef,
  changedDiffs,
  allFiles,
  existingReview = null,
  isIncremental = false,
  intentContext = null,
  language = "English",
  maxPatchChars = 110000,
}) {
  const lang = String(language || "English").trim() || "English";
  const lines = [];
  lines.push("You are a sharp, calm senior teammate giving a tired high-level reviewer a 10-second scannable brief on AI-generated code.");
  lines.push("HIGH-LEVEL VIEWER ASSUMPTION (STRICT):");
  lines.push("- Assume the reader did NOT write this branch and has NEVER dug down into its internal layers, helpers, or filenames.");
  lines.push("- Always explain top-down from user/product behavior first, never bottom-up from internal class or function names.");
  lines.push("WRITING STYLE RULES (STRICT):");
  lines.push(`- LANGUAGE: Write ALL human-readable text (title, tldr, story, bullets, uiChanges, intentCheck, diagram labels, layer titles/summaries, file roles/summaries, finding titles/impact/body) in natural ${lang}. Keep JSON keys, file paths, and code snippets untouched.`);
  lines.push("- RELEASE PITCH + BEFORE -> NOW (`story`, MOST IMPORTANT): NEVER describe the new behavior in a vacuum! A reviewer who doesn't know the old behavior cannot tell what actually changed.");
  lines.push("  * `story.pitch`: Write a clear, confident 1-2 sentence 'PR statement' defending why this branch exists and what it gives the user/team (demo-ready, zero code jargon).");
  lines.push("  * `story.before`: State factually how it behaved BEFORE (read removed lines/docs so you catch specifics like 'shipping always charged a flat $10 fee').");
  lines.push("  * `story.after`: State how it works NOW in direct contrast to `before`.");
  lines.push("  * `story.example`: Add 1 concrete example with numbers/action when it makes the change click instantly (e.g. '$75 cart with 10% member tier -> $67.50 total').");
  lines.push("- Write in calm, plain everyday language. Sound like a helpful coworker, NEVER robotic or academic.");
  lines.push("- NO walls of text. Keep every sentence short (under 15 words).");
  lines.push("- NO symbol-name soup in title, tldr, bullets, or layer summaries! Describe WHAT happens in plain words instead of dumping class/method/endpoint names like ProcessOrderBatchAsync or PUT /v1/orders/{id}.");
  lines.push("- Lead findings with the real-world consequence (what breaks if you ship it), not abstract pattern lectures.");
  lines.push("- Never use em dashes.");
  lines.push("- Group all changed files into logical, dependency-ordered review layers (foundations first -> logic/API -> UI -> tests/docs).");
  lines.push("- VISIBLE UI CHANGES (`uiChanges`): If any frontend/UI screen, button, field, dropdown, table, or message changed, list each visible change in demo-ready plain language (`screen`, `change`, `detail`) so the developer can explain it directly to teammates or customers. Leave `uiChanges: []` if nothing user-visible changed.");
  lines.push("- HOW IT CONNECTS (`diagram`, USER/FRONTEND-FIRST ORDER): Whenever this branch touches 2+ areas, fill `diagram` with 3-5 plain-language nodes and 3-5 ordered edges starting from the USER / SCREEN action (or external trigger) and flowing downstream: Screen -> Endpoint -> Backend -> Database (NEVER database-first!). Link each changed node's `layerId` so clicking it opens that layer. Leave `nodes: []` only for tiny isolated 1-area tweaks.");
  lines.push("FINDING ACCURACY RULES (STRICT):");
  lines.push("- VERIFY BEFORE REPORTING: If you have read-only repo tools (Read/Grep/Glob), check the actual definitions, defaults, null-fallbacks (e.g. try/coalesce), callers, and schemas in the codebase before reporting ANY bug.");
  lines.push("- ZERO SPECULATION: Never flag a 'might fail' or 'could overwrite' issue based only on a partial diff hunk. If surrounding code handles it safely, omit the finding.");
  lines.push("- HIGH SIGNAL ONLY: Report only verified bugs, security risks, data loss, or broken edge cases. Skip comment-wording nits and style tweaks. An empty `findings: []` array is ideal for a clean branch.");
  lines.push("- Anchor every finding to exact NEW-file line numbers from the diff.");
  lines.push("");
  lines.push(`Branch: ${branch || "HEAD"} (compared against ${baseRef || "base"})`);
  lines.push(`Total files in branch: ${(allFiles || []).length}`);

  if (intentContext && (intentContext.pr || (intentContext.issues && intentContext.issues.length))) {
    lines.push("");
    lines.push("PR / ISSUE INTENT CONTEXT (compare the actual diff against this goal and fill `intentCheck`):");
    if (intentContext.pr) {
      lines.push(`PR #${intentContext.pr.number}: ${intentContext.pr.title}`);
      if (intentContext.pr.body) lines.push(intentContext.pr.body);
    }
    for (const iss of intentContext.issues || []) {
      lines.push(`Linked Issue #${iss.number}: ${iss.title}`);
      if (iss.body) lines.push(iss.body);
    }
    lines.push("In `intentCheck`, set status to `aligned`, `partial`, or `mismatch`, write a 1-sentence verdict, and list any concrete missed requirements or unexpected scope in `gaps`.");
  } else {
    lines.push("No PR or linked issue context was found. Set `intentCheck` to `{ status: \"none\", summary: \"\", gaps: [] }`.");
  }

  if (isIncremental && existingReview) {
    lines.push("");
    lines.push("MODE: INCREMENTAL UPDATE.");
    lines.push("Only the newly added or modified files below have changed since the previous review.");
    lines.push("Rules for incremental update:");
    lines.push("1. Reuse existing layer IDs/titles where still accurate, place newly added files into appropriate layers (or add/adjust a layer only if needed), and remove deleted files from layers.");
    lines.push("2. Every file listed under ALL CURRENT BRANCH FILES must appear in at least one layer.");
    lines.push("3. In `fileSummaries` and `findings`, ONLY output entries for the CHANGED FILES shown in the diffs below (unchanged files will be preserved automatically from cache).");
    lines.push("4. If a previously reported finding on a changed file has been fixed in the new diff, omit it from `findings`.");
    lines.push("");
    lines.push("EXISTING REVIEW OUTLINE:");
    lines.push(JSON.stringify({
      title: existingReview.title,
      summary: existingReview.summary,
      layers: (existingReview.layers || []).map(l => ({
        id: l.id,
        title: l.title,
        summary: l.summary,
        dependsOn: l.dependsOn || [],
        files: (l.files || []).map(f => f.path),
      })),
    }, null, 2));

    const changedSet = new Set((changedDiffs || []).map(d => d.path));
    const prevFindingsOnChanged = (existingReview.findings || []).filter(f => changedSet.has(f.file));
    if (prevFindingsOnChanged.length) {
      lines.push("");
      lines.push("PREVIOUS FINDINGS ON THESE CHANGED FILES (re-check whether fixed):");
      lines.push(JSON.stringify(prevFindingsOnChanged.map(f => ({
        file: f.file, lineStart: f.lineStart, lineEnd: f.lineEnd, severity: f.severity, title: f.title,
      })), null, 2));
    }
  } else {
    lines.push("");
    lines.push("MODE: FULL REVIEW.");
    lines.push("Every file listed under ALL CURRENT BRANCH FILES must appear in at least one layer.");
  }

  lines.push("");
  lines.push("ALL CURRENT BRANCH FILES:");
  for (const f of allFiles || []) {
    lines.push(`- [${f.status}] ${f.path} (+${f.added || 0} -${f.removed || 0})`);
  }

  lines.push("");
  lines.push(isIncremental ? "DIFFS FOR CHANGED FILES ONLY:" : "DIFFS:");
  let budget = maxPatchChars;
  for (const d of changedDiffs || []) {
    const header = `\n=== FILE: ${d.path} (${d.status}, +${d.added || 0} -${d.removed || 0}) ===\n`;
    const body = d.binary ? "(binary file)" : String(d.patch || "(empty diff)");
    if (budget <= 0) {
      lines.push(`${header}(diff omitted due to context budget; classify by path/stats)`);
      continue;
    }
    if (body.length > budget) {
      lines.push(`${header}${body.slice(0, budget)}\n... (truncated)`);
      budget = 0;
    } else {
      lines.push(`${header}${body}`);
      budget -= body.length;
    }
  }

  lines.push("");
  lines.push("Return ONLY valid JSON matching the required schema (no markdown fences, no commentary).");
  return lines.join("\n");
}

// Pass 2 dedicated adversarial bug-hunt prompt for large PRs (strictly production/infra files, skips tests/docs/generated).
export function buildBugHuntPrompt({
  branch,
  baseRef,
  targetDiffs,
  skippedCount = 0,
  existingFindings = [],
  intentContext = null,
  language = "English",
  maxPatchChars = 110000,
}) {
  const lang = String(language || "English").trim() || "English";
  const lines = [];
  lines.push("You are doing Pass 2: a dedicated, high-precision adversarial bug hunt on a large branch.");
  lines.push("RULES (STRICT):");
  lines.push(`- LANGUAGE: Write finding titles, impact, and body in natural ${lang}. Keep JSON keys, paths, and code snippets untouched.`);
  lines.push("- FOCUS ONLY ON PRODUCTION & INFRA CODE: Test files, snapshots, lockfiles, docs, and generated files have been excluded. Do NOT report issues in test files, comments, or formatting.");
  lines.push("- VERIFY EVERY CANDIDATE BUG: Use Read/Grep/Glob to inspect callers, defaults, null-fallbacks, schemas, and sibling files BEFORE reporting. Zero speculation.");
  lines.push("- Look for real bugs Pass 1 can miss on large PRs: broken contracts between layers, auth/permission gaps, race conditions, state/cache staleness, data loss, migration hazards, silent failure paths.");
  lines.push("- Never use em dashes. Keep every sentence short and concrete.");
  lines.push("- Do not duplicate findings already listed under PASS 1 FINDINGS.");
  lines.push("- Returning `{ \"findings\": [] }` is the right answer if no additional verified bugs exist.");
  lines.push("");
  lines.push(`Branch: ${branch || "HEAD"} (vs ${baseRef || "base"})`);
  lines.push(`Production files in Pass 2: ${(targetDiffs || []).length} (${skippedCount} test/doc/generated files skipped)`);

  if (intentContext?.pr) {
    lines.push(`PR #${intentContext.pr.number}: ${intentContext.pr.title}`);
  }
  if (existingFindings.length) {
    lines.push("");
    lines.push("PASS 1 FINDINGS (do not duplicate):");
    lines.push(JSON.stringify(existingFindings.map(f => ({
      file: f.file, lineStart: f.lineStart, severity: f.severity, title: f.title,
    })), null, 2));
  }

  lines.push("");
  lines.push("PRODUCTION / INFRA DIFFS TO AUDIT:");
  let budget = maxPatchChars;
  for (const d of targetDiffs || []) {
    const header = `\n=== FILE: ${d.path} (${d.status}, +${d.added || 0} -${d.removed || 0}) ===\n`;
    const body = String(d.patch || "(empty diff)");
    if (budget <= 0) {
      lines.push(`${header}(diff omitted due to context budget; inspect with Read if needed)`);
      continue;
    }
    if (body.length > budget) {
      lines.push(`${header}${body.slice(0, budget)}\n... (truncated)`);
      budget = 0;
    } else {
      lines.push(`${header}${body}`);
      budget -= body.length;
    }
  }

  lines.push("");
  lines.push("Return ONLY valid JSON matching the required schema.");
  return lines.join("\n");
}

// Read-only follow-up Q&A prompt scoped to the branch, a layer, a file, or a specific finding.
// Includes recent prior Q&As for follow-up continuity and explicitly flags any that predate file changes.
export function buildAskPrompt({ question, scope = {}, review = null, currentBranchHash = "", language = "English" }) {
  const lang = String(language || "English").trim() || "English";
  const lines = [];
  lines.push("You are a sharp, calm senior teammate answering a tired high-level reviewer's question about AI-generated code.");
  lines.push("FORMATTING & STYLE RULES (STRICT):");
  lines.push("- Assume the reader stays at a high level and never dug through the internal layers. Explain the real behavior simply before citing any code.");
  lines.push(`- Write in natural ${lang}, plain everyday language. Never use em dashes.`);
  lines.push("- NO walls of text! Put the direct answer in `tldr` (1 short sentence, max 18 words) and 0-4 ultra-short scannable points in `bullets` (max 14 words each).");
  lines.push("- Use `inline code` sparingly for symbol names and **bold** for key takeaways.");
  lines.push("- Use Read/Grep/Glob to verify your answer against the real codebase before replying.");
  lines.push("- GITHUB-STYLE CODE SNIPPETS: Whenever showing 2-10 lines of actual code makes the answer immediately clear, include 1-2 entries in `snippets` with the exact repo-relative `file`, 1-based `lineStart`, `lineEnd`, and a short `caption` (the UI will render those real lines directly from disk).");
  lines.push("");
  if (review) {
    lines.push(`Branch: ${review.branch || "HEAD"} (vs ${review.baseRef || "base"})`);
    if (review.title) lines.push(`Summary: ${review.title} - ${review.tldr || review.summary || ""}`);
  }
  if (scope?.type === "layer" && scope.layer) {
    lines.push("");
    lines.push(`SCOPED LAYER: ${scope.layer.title}`);
    if (scope.layer.summary) lines.push(`Layer summary: ${scope.layer.summary}`);
    lines.push(`Layer files: ${(scope.layer.files || []).map(f => f.path).join(", ")}`);
  } else if (scope?.type === "finding" && scope.finding) {
    const f = scope.finding;
    lines.push("");
    lines.push(`SCOPED FINDING: [${f.severity}] ${f.title} (${f.file}:${f.lineStart}-${f.lineEnd})`);
    if (f.impact) lines.push(`Claimed impact: ${f.impact}`);
    if (f.body) lines.push(`Details: ${f.body}`);
  } else if (scope?.type === "file" && scope.file) {
    lines.push("");
    lines.push(`SCOPED FILE: ${scope.file}`);
  }

  const priorQa = Array.isArray(review?.qa) ? review.qa.slice(-5) : [];
  if (priorQa.length) {
    lines.push("");
    lines.push("PRIOR Q&A HISTORY ON THIS BRANCH (use for follow-up context; if marked OUTDATED, files changed since then so re-verify against current code):");
    for (const q of priorQa) {
      const outdated = Boolean(currentBranchHash && q.branchHash && q.branchHash !== currentBranchHash);
      const tag = outdated ? "[OUTDATED - code changed since this answer]" : "[current]";
      lines.push(`- ${tag} Q: ${q.question}`);
      const ans = q.tldr || q.answer || "";
      if (ans) lines.push(`  A: ${ans}`);
    }
  }

  lines.push("");
  lines.push(`DEVELOPER QUESTION: ${String(question || "").trim()}`);
  lines.push("");
  lines.push("Return ONLY valid JSON matching the required schema: { \"tldr\", \"bullets\", \"snippets\" }.");
  return lines.join("\n");
}

// Extracts structured JSON from Claude CLI (--output-format json), Codex, or Gemini stdout.
export function extractAiJson(stdout) {
  const raw = String(stdout || "").trim();
  if (!raw) throw new Error("AI engine returned empty output");

  const tryParse = s => {
    try { return JSON.parse(s); } catch { return null; }
  };

  let parsed = tryParse(raw);
  // Claude `--output-format json` wraps output in an envelope object.
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    if (parsed.structured_output && typeof parsed.structured_output === "object") {
      return parsed.structured_output;
    }
    if (typeof parsed.result === "string") {
      const inner = extractFromText(parsed.result);
      if (inner) return inner;
    }
    if (Array.isArray(parsed.layers)) return parsed;
    if (parsed.is_error && parsed.result) throw new Error(String(parsed.result));
  }

  const fromText = extractFromText(raw);
  if (fromText) return fromText;
  throw new Error("Could not parse structured JSON from AI response");
}

function extractFromText(text) {
  const s = String(text || "").trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch {}
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) {
    try { return JSON.parse(fence[1].trim()); } catch {}
  }
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try { return JSON.parse(s.slice(first, last + 1)); } catch {}
  }
  return null;
}

// Merges an AI output (full or incremental) with cached unchanged files/findings.
export function mergeExplainResult(existingReview, aiOutput, currentFiles, meta = {}) {
  const files = Array.isArray(currentFiles) ? currentFiles : [];
  const curByPath = new Map(files.map(f => [f.path, f]));
  const changedPaths = new Set(meta.changedPaths || files.map(f => f.path));
  const isIncremental = Boolean(meta.isIncremental && existingReview);

  // 1. Build files map (preserve unchanged summaries, update changed ones)
  const aiSummaryByPath = new Map();
  for (const item of aiOutput?.fileSummaries || []) {
    if (item?.path) aiSummaryByPath.set(item.path, String(item.summary || "").trim());
  }
  const nextFiles = {};
  for (const f of files) {
    const prev = isIncremental ? existingReview.files?.[f.path] : null;
    const summary = aiSummaryByPath.get(f.path) || prev?.summary || "";
    nextFiles[f.path] = {
      patchHash: f.patchHash || "",
      status: f.status || "M",
      added: Number(f.added || 0),
      removed: Number(f.removed || 0),
      binary: Boolean(f.binary),
      summary,
    };
  }

  // 2. Normalize layers & guarantee every current file is covered
  const rawLayers = Array.isArray(aiOutput?.layers) ? aiOutput.layers : [];
  const seenFiles = new Set();
  const layers = [];
  for (let i = 0; i < rawLayers.length; i++) {
    const l = rawLayers[i] || {};
    const id = String(l.id || `layer-${i + 1}`).trim() || `layer-${i + 1}`;
    const layerFiles = [];
    for (const lf of Array.isArray(l.files) ? l.files : []) {
      const p = typeof lf === "string" ? lf : lf?.path;
      if (!p || !curByPath.has(p)) continue;
      if (layerFiles.some(x => x.path === p)) continue;
      seenFiles.add(p);
      layerFiles.push({
        path: p,
        role: (typeof lf === "object" ? String(lf.role || "").trim() : "") || nextFiles[p]?.summary || "",
      });
    }
    if (!layerFiles.length) continue;
    layers.push({
      id,
      title: String(l.title || `Layer ${layers.length + 1}`).trim(),
      summary: String(l.summary || "").trim(),
      dependsOn: Array.isArray(l.dependsOn) ? l.dependsOn.map(String).filter(Boolean) : [],
      files: layerFiles,
    });
  }
  const validLayerIds = new Set(layers.map(l => l.id));
  for (const l of layers) {
    l.dependsOn = l.dependsOn.filter(id => id !== l.id && validLayerIds.has(id));
  }

  const missing = files.filter(f => !seenFiles.has(f.path));
  if (missing.length) {
    layers.push({
      id: "layer-other",
      title: layers.length ? "Other changes" : "All changes",
      summary: "Files not assigned to a specific layer.",
      dependsOn: [],
      files: missing.map(f => ({ path: f.path, role: nextFiles[f.path]?.summary || "" })),
    });
  }

  // 3. Merge findings: keep cached findings for unchanged files; replace findings for changed files
  const keptFindings = isIncremental
    ? (existingReview.findings || []).filter(f => curByPath.has(f.file) && !changedPaths.has(f.file))
    : [];

  const newFindings = [];
  for (const raw of Array.isArray(aiOutput?.findings) ? aiOutput.findings : []) {
    if (!raw?.file || !curByPath.has(raw.file)) continue;
    if (isIncremental && !changedPaths.has(raw.file)) continue;
    const lineStart = Math.max(1, Math.floor(Number(raw.lineStart) || 1));
    const lineEnd = Math.max(lineStart, Math.floor(Number(raw.lineEnd) || lineStart));
    const f = {
      file: String(raw.file),
      lineStart,
      lineEnd,
      severity: normalizeSeverity(raw.severity),
      category: String(raw.category || "bug").toLowerCase(),
      title: String(raw.title || "Potential issue").trim(),
      impact: String(raw.impact || "").trim(),
      body: String(raw.body || "").trim(),
      suggestion: String(raw.suggestion || "").trim(),
    };
    f.id = findingIdFor(f);
    newFindings.push(f);
  }

  const dedup = new Map();
  for (const f of [...keptFindings, ...newFindings]) {
    const id = f.id || findingIdFor(f);
    dedup.set(id, { ...f, id });
  }
  const findings = [...dedup.values()].sort((a, b) => {
    const sa = SEVERITY_ORDER.indexOf(a.severity);
    const sb = SEVERITY_ORDER.indexOf(b.severity);
    if (sa !== sb) return sa - sb;
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    return (a.lineStart || 0) - (b.lineStart || 0);
  });

  // 4. Preserve resolvedIds for findings that still exist
  const activeIds = new Set(findings.map(f => f.id));
  const resolvedIds = (existingReview?.resolvedIds || []).filter(id => activeIds.has(id));

  const bullets = Array.isArray(aiOutput?.bullets)
    ? aiOutput.bullets
        .filter(b => b && (b.lead || b.text))
        .map(b => ({ lead: String(b.lead || "").trim(), text: String(b.text || "").trim() }))
        .slice(0, 5)
    : (existingReview?.bullets || []);

  const rawStory = aiOutput?.story;
  const story = rawStory && typeof rawStory === "object"
    ? {
        pitch: String(rawStory.pitch || "").trim(),
        before: String(rawStory.before || "").trim(),
        after: String(rawStory.after || "").trim(),
        example: String(rawStory.example || "").trim(),
      }
    : (existingReview?.story || null);

  const uiChanges = Array.isArray(aiOutput?.uiChanges)
    ? aiOutput.uiChanges
        .filter(u => u && (u.change || u.screen))
        .map(u => ({
          screen: String(u.screen || "").trim(),
          change: String(u.change || "").trim(),
          detail: String(u.detail || "").trim(),
        }))
        .slice(0, 8)
    : (existingReview?.uiChanges || []);

  const rawIntent = aiOutput?.intentCheck;
  const intentCheck = rawIntent && typeof rawIntent === "object"
    ? {
        status: ["aligned", "partial", "mismatch", "none"].includes(rawIntent.status) ? rawIntent.status : "none",
        summary: String(rawIntent.summary || "").trim(),
        gaps: Array.isArray(rawIntent.gaps) ? rawIntent.gaps.map(g => String(g || "").trim()).filter(Boolean).slice(0, 6) : [],
      }
    : (existingReview?.intentCheck || { status: "none", summary: "", gaps: [] });

  const rawDiag = aiOutput?.diagram;
  const diagram = rawDiag && typeof rawDiag === "object" && Array.isArray(rawDiag.nodes)
    ? {
        caption: String(rawDiag.caption || "").trim(),
        nodes: rawDiag.nodes
          .filter(n => n && n.id && n.label)
          .slice(0, 10)
          .map(n => ({
            id: String(n.id).trim(),
            label: String(n.label).trim(),
            kind: ["ui", "api", "service", "data", "infra", "external"].includes(n.kind) ? n.kind : "service",
            changed: Boolean(n.changed),
            layerId: String(n.layerId || "").trim(),
          })),
        edges: (Array.isArray(rawDiag.edges) ? rawDiag.edges : [])
          .filter(e => e && e.from && e.to)
          .slice(0, 16)
          .map(e => ({ from: String(e.from).trim(), to: String(e.to).trim(), label: String(e.label || "").trim() })),
      }
    : (existingReview?.diagram || { caption: "", nodes: [], edges: [] });

  const intentContext = meta.intentContext !== undefined
    ? meta.intentContext
    : (existingReview?.intentContext || null);

  const bugHuntPass = meta.bugHuntPass !== undefined
    ? meta.bugHuntPass
    : (existingReview?.bugHuntPass || null);

  const qa = Array.isArray(existingReview?.qa) ? existingReview.qa : [];

  return {
    version: 1,
    root: meta.root || existingReview?.root || "",
    branch: meta.branch || existingReview?.branch || "",
    baseRef: meta.baseRef || existingReview?.baseRef || "",
    baseSha: meta.baseSha || existingReview?.baseSha || "",
    engine: meta.engine || existingReview?.engine || "claude",
    model: meta.model ?? existingReview?.model ?? "",
    language: meta.language || existingReview?.language || "English",
    updatedAt: meta.updatedAt || Date.now(),
    lastRunMode: isIncremental ? "incremental" : "full",
    lastAnalyzedFiles: meta.analyzedFiles ?? files.length,
    lastReusedFiles: meta.reusedFiles ?? 0,
    title: String(aiOutput?.title || existingReview?.title || meta.branch || "Branch review").trim(),
    tldr: String(aiOutput?.tldr || existingReview?.tldr || "").trim(),
    story,
    bullets,
    summary: String(aiOutput?.summary || existingReview?.summary || "").trim(),
    uiChanges,
    intentCheck,
    intentContext,
    diagram,
    bugHuntPass,
    qa,
    layers,
    files: nextFiles,
    findings,
    resolvedIds,
  };
}

// Computes KPI rollups for the wf-explain Overview and left rail.
export function summarizeExplain(review) {
  if (!review) {
    return {
      layerCount: 0,
      layersWithFindings: 0,
      fileCount: 0,
      added: 0,
      removed: 0,
      openFindings: [],
      resolvedFindings: [],
      counts: { critical: 0, major: 0, minor: 0, nit: 0 },
      byLayer: new Map(),
      byFile: new Map(),
    };
  }
  const resolvedSet = new Set(review.resolvedIds || []);
  const filesArr = Object.values(review.files || {});
  const added = filesArr.reduce((n, f) => n + (f.added || 0), 0);
  const removed = filesArr.reduce((n, f) => n + (f.removed || 0), 0);

  const openFindings = [];
  const resolvedFindings = [];
  const counts = { critical: 0, major: 0, minor: 0, nit: 0 };
  const byFile = new Map();

  for (const f of review.findings || []) {
    const resolved = resolvedSet.has(f.id);
    if (resolved) resolvedFindings.push(f);
    else {
      openFindings.push(f);
      counts[f.severity] = (counts[f.severity] || 0) + 1;
    }
    const list = byFile.get(f.file) || [];
    list.push({ ...f, resolved });
    byFile.set(f.file, list);
  }

  const byLayer = new Map();
  let layersWithFindings = 0;
  for (const l of review.layers || []) {
    const c = { critical: 0, major: 0, minor: 0, nit: 0, total: 0 };
    for (const lf of l.files || []) {
      for (const f of byFile.get(lf.path) || []) {
        if (f.resolved) continue;
        c[f.severity] = (c[f.severity] || 0) + 1;
        c.total++;
      }
    }
    if (c.total > 0) layersWithFindings++;
    byLayer.set(l.id, c);
  }

  return {
    layerCount: (review.layers || []).length,
    layersWithFindings,
    fileCount: filesArr.length,
    added,
    removed,
    openFindings,
    resolvedFindings,
    counts,
    byLayer,
    byFile,
  };
}

export function formatFindingFixPrompt(finding) {
  if (!finding) return "";
  const loc = finding.lineEnd && finding.lineEnd !== finding.lineStart
    ? `${finding.file}:${finding.lineStart}-${finding.lineEnd}`
    : `${finding.file}:${finding.lineStart || 1}`;
  const parts = [
    `An automated diff review flagged a potential ${finding.severity} (${finding.category}) issue at ${loc}.`,
    "First verify against the full codebase whether this is a real bug or a false positive.",
    "If it is a real bug, fix it. If it is not a bug, briefly explain why it is safe and do not make unnecessary edits.",
    "",
    `Title: ${finding.title}`,
  ];
  if (finding.impact) parts.push(`Claimed impact: ${finding.impact}`);
  if (finding.body) parts.push(`Details: ${finding.body}`);
  if (finding.suggestion) parts.push(`Suggested fix:\n${finding.suggestion}`);
  return parts.join("\n");
}

export function formatQaContinuePrompt(item, { outdated = false } = {}) {
  if (!item) return "";
  const parts = [];
  const scopeLabel = item.scopeLabel
    ? `${item.scopeType || "branch"} (${item.scopeLabel})`
    : (item.scopeType || "branch");
  parts.push(`Continuing a Q&A from AI Explain about ${scopeLabel}:`);
  if (outdated) parts.push("(Note: files on this branch have changed since this Q&A was generated, so re-check the current code first.)");
  parts.push(`Question: ${item.question || ""}`);
  const tldr = item.tldr || item.answer || "";
  if (tldr) parts.push(`Summary answer: ${tldr}`);
  if (Array.isArray(item.bullets) && item.bullets.length) {
    parts.push("Key points:");
    for (const b of item.bullets) parts.push(`- ${b}`);
  }
  if (Array.isArray(item.snippets) && item.snippets.length) {
    parts.push("Referenced code:");
    for (const sn of item.snippets) {
      const loc = sn.lineEnd && sn.lineEnd !== sn.lineStart
        ? `${sn.file}#L${sn.lineStart}-L${sn.lineEnd}`
        : `${sn.file}#L${sn.lineStart || 1}`;
      parts.push(`- ${loc}${sn.caption ? ` (${sn.caption})` : ""}`);
    }
  }
  parts.push("");
  parts.push("Keep this context in mind — I'm ready to continue discussing or acting on this.");
  return parts.join("\n");
}

// Concept-first instant search across findings, layers, plain-English file roles, paths, and Q&As.
export function searchExplainReview(review, rawQuery) {
  const q = String(rawQuery || "").trim().toLowerCase();
  if (!review || !q) return { findings: [], layers: [], files: [], qa: [], total: 0 };
  const terms = q.split(/\s+/).filter(Boolean);
  const matches = (...fields) => {
    const hay = fields.map(x => String(x || "").toLowerCase()).join(" ");
    return terms.every(t => hay.includes(t));
  };

  const findings = (review.findings || []).filter(f =>
    matches(f.title, f.impact, f.body, f.file, f.severity, f.category)
  );
  const layers = (review.layers || []).filter(l =>
    matches(l.title, l.summary)
  );
  const files = [];
  const seenFiles = new Set();
  for (const l of review.layers || []) {
    for (const lf of l.files || []) {
      if (seenFiles.has(lf.path)) continue;
      const meta = review.files?.[lf.path];
      if (matches(lf.path, lf.role, meta?.summary, l.title)) {
        seenFiles.add(lf.path);
        files.push({ path: lf.path, role: lf.role || meta?.summary || "", layerId: l.id, layerTitle: l.title });
      }
    }
  }
  const qa = (review.qa || []).filter(item =>
    matches(item.question, item.tldr, item.answer, ...(item.bullets || []))
  );

  return {
    findings,
    layers,
    files,
    qa,
    total: findings.length + layers.length + files.length + qa.length,
  };
}

export function formatRelativeAge(ts, now = Date.now()) {
  if (!ts) return "";
  const sec = Math.max(0, Math.floor((now - ts) / 1000));
  if (sec < 45) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}
