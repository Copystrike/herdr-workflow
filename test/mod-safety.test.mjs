// Static safety & contract tests for every Herdr mod in mods/*.
// Catches render-time host-call crashes (e.g. InputState.new inside render),
// missing icon assets, missing checking() guards, and herdr-app check failures.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MODS_DIR = join(ROOT, "mods");
const HERDR_HOME = process.env.HERDR_APP_HOME || join(process.env.HOME || "", ".config/herdr-app");
const MOD_NAMES = readdirSync(MODS_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();

const HOST_STATE_CTOR = /\b(?:InputState|EditorState|TextareaState|SliderState)\.new\s*\(/;
const SYNC_NOTIFY = /\bcx\.notify\s*\(/;

// Extracts top-level method blocks inside a class by brace-depth tracking.
function extractMethods(src) {
  const methods = [];
  const re = /^\s{2}(?:async\s+)?([a-zA-Z_$][\w$]*)\s*\([^)]*\)\s*\{/gm;
  let m;
  while ((m = re.exec(src))) {
    const name = m[1];
    if (["if", "for", "while", "switch", "catch"].includes(name)) continue;
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    methods.push({ name, body: src.slice(m.index, i + 1) });
  }
  return methods;
}

// Strips deferred arrow callbacks (e.g. `.on_click((_e, cx) => ...)`, `cx.spawn(async cx => ...)`,
// `tabBtn(..., cx => this.openSettingsTab(cx))`) with balanced paren/brace tracking so only
// synchronous render-time calls are checked.
function stripDeferredCallbacks(code) {
  let out = "";
  const isCallbackStart = (src, i) => {
    const sub = src.slice(i);
    return /^(?:async\s+)?(?:\([^)]*\)|[a-zA-Z_$][\w$]*)\s*=>/.exec(sub);
  };
  for (let i = 0; i < code.length; i++) {
    // Look for `=>` preceded by callback params after `(`, `,`, or `:`
    if (i > 0 && (code[i - 1] === "(" || code[i - 1] === "," || code[i - 1] === ":" || /\s/.test(code[i - 1]))) {
      const m = isCallbackStart(code, i);
      if (m) {
        // Keep `.map(...)` / `.filter(...)` / `.when(...)` / `.hover(...)` callbacks because THOSE run synchronously during render!
        const before = out.slice(-40);
        const isSyncArrayOrWhen = /\.(?:map|filter|flatMap|forEach|reduce|find|some|every|when|hover)\s*\(\s*(?:[^,]+,\s*)?$/.test(before);
        if (!isSyncArrayOrWhen) {
          let j = i + m[0].length;
          while (j < code.length && /\s/.test(code[j])) j++;
          if (code[j] === "{") {
            let d = 0;
            for (; j < code.length; j++) {
              if (code[j] === "{") d++;
              else if (code[j] === "}") { d--; if (d === 0) { j++; break; } }
            }
          } else {
            let p = 0;
            for (; j < code.length; j++) {
              if (code[j] === "(" || code[j] === "[" || code[j] === "{") p++;
              else if (code[j] === ")" || code[j] === "]" || code[j] === "}") {
                if (p === 0) break;
                p--;
              } else if (code[j] === "," && p === 0) break;
            }
          }
          out += "/*cb*/";
          i = j - 1;
          continue;
        }
      }
    }
    out += code[i];
  }
  return out;
}

test("mod-safety: no retained GPUI state constructors (InputState/EditorState/etc.) reachable from render() or draw()", () => {
  for (const mod of MOD_NAMES) {
    const file = join(MODS_DIR, mod, "main.js");
    const src = readFileSync(file, "utf8");
    const methods = extractMethods(src);
    const byName = new Map(methods.map(m => [m.name, m.body]));

    // Walk every method transitively called via `this.<name>(` synchronously from render / draw / render*
    const renderEntry = methods.filter(m => m.name === "render" || m.name === "draw" || m.name.startsWith("render"));
    const visited = new Set();
    const queue = renderEntry.map(m => m.name);
    while (queue.length) {
      const name = queue.shift();
      if (visited.has(name)) continue;
      visited.add(name);
      const body = byName.get(name) || "";
      const syncCode = stripDeferredCallbacks(body);
      assert.equal(
        HOST_STATE_CTOR.test(syncCode),
        false,
        `${mod}/main.js: retained state constructor (${syncCode.match(HOST_STATE_CTOR)?.[0]}) must NOT be called inside render-reachable method ${name}()`,
      );
      for (const call of syncCode.matchAll(/this\.([a-zA-Z_$][\w$]*)\s*\(/g)) {
        const target = call[1];
        if (byName.has(target) && !visited.has(target)) queue.push(target);
      }
    }
  }
});

test("mod-safety: no unguarded synchronous cx.notify() directly inside render() or draw()", () => {
  for (const mod of MOD_NAMES) {
    const file = join(MODS_DIR, mod, "main.js");
    const src = readFileSync(file, "utf8");
    const methods = extractMethods(src);
    for (const m of methods) {
      if (m.name !== "render" && m.name !== "draw") continue;
      const syncCode = stripDeferredCallbacks(m.body);
      assert.equal(SYNC_NOTIFY.test(syncCode), false, `${mod}/main.js calls cx.notify() synchronously inside ${m.name}()`);
    }
  }
});

test("mod-safety: no hex alpha concatenation onto 8-digit theme tokens (border/hover/selected)", () => {
  const BAD_ALPHA = /\bt\.(?:border|hover|selected)\s*\+\s*["'][0-9a-fA-F]{2}["']/;
  for (const mod of MOD_NAMES) {
    const file = join(MODS_DIR, mod, "main.js");
    const src = readFileSync(file, "utf8");
    const hit = src.match(BAD_ALPHA);
    assert.equal(hit, null, `${mod}/main.js appends hex alpha to an 8-digit theme token: ${hit?.[0]}`);
  }
});

test("mod-safety: every svg(\"mods/...\") asset path exists in repo or herdr home", () => {
  for (const mod of MOD_NAMES) {
    const file = join(MODS_DIR, mod, "main.js");
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/\bsvg\(\s*"(mods\/[^"]+)"\s*\)/g)) {
      const rel = m[1];
      const inRepo = join(ROOT, rel);
      const inHome = join(HERDR_HOME, rel);
      assert.ok(existsSync(inRepo) || existsSync(inHome), `${mod}/main.js references missing SVG asset: ${rel}`);
    }
  }
});

test("mod-safety: mods using cx.timer or cx.spawn in init() guard with checking()", () => {
  for (const mod of MOD_NAMES) {
    const file = join(MODS_DIR, mod, "main.js");
    const src = readFileSync(file, "utf8");
    const init = extractMethods(src).find(m => m.name === "init");
    if (!init) continue;
    if (/cx\.timer\.|cx\.spawn\(/.test(init.body)) {
      assert.ok(/\bchecking\s*\(\s*\)/.test(init.body), `${mod}/main.js: init() uses timers/spawns without checking() guard`);
    }
  }
});

test("mod-safety: herdr-app check passes for every installed mod", () => {
  for (const mod of MOD_NAMES) {
    const dest = join(HERDR_HOME, "mods", mod);
    if (!existsSync(dest)) continue;
    const out = execFileSync("herdr-app", ["check", dest], { encoding: "utf8" });
    assert.match(out, /check passed:/, `herdr-app check failed for ${mod}: ${out}`);
  }
});
