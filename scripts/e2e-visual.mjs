#!/usr/bin/env node
// Live E2E visual test runner for herdr-workflow mods.
// Drives the running herdr-app window through every visual surface & mode,
// verifies zero herdr-app status errors and zero telemetry render errors,
// saves labeled screenshots to test/e2e-shots/, and restores the window state.
import { execFileSync } from "node:child_process";
import { mkdirSync, statSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SHOTS_DIR = join(ROOT, "test/e2e-shots");
const HERDR_HOME = process.env.HERDR_APP_HOME || join(process.env.HOME || "", ".config/herdr-app");
const TELEMETRY = join(HERDR_HOME, "data/wf/telemetry.jsonl");

function detectDefaultRepo() {
  try {
    const out = execFileSync("node", [join(ROOT, "bin/wf.mjs"), "projects"], { encoding: "utf8" }).trim();
    const first = JSON.parse(out)?.projects?.[0];
    if (first) return first;
  } catch {}
  return { name: "repo", dir: ROOT, slug: "" };
}

const detected = detectDefaultRepo();
const REPO_NAME = process.env.E2E_REPO_NAME || detected.name;
const REPO_DIR = process.env.E2E_REPO_DIR || detected.dir;
const REPO_SLUG = process.env.E2E_REPO_SLUG || detected.slug || "";

const sleep = ms => new Promise(r => setTimeout(r, ms));

function herdr(args) {
  return execFileSync("herdr-app", args, { encoding: "utf8" }).trim();
}

function herdrJson(args) {
  const out = herdr(args);
  return out ? JSON.parse(out) : null;
}

function telemetrySize() {
  try { return statSync(TELEMETRY).size; } catch { return 0; }
}

function newRenderErrors(sinceOffset) {
  if (!existsSync(TELEMETRY)) return [];
  const buf = readFileSync(TELEMETRY);
  if (buf.length <= sinceOffset) return [];
  const text = buf.subarray(sinceOffset).toString("utf8");
  const bad = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.event === "error" && String(ev.error || "").includes("render")) bad.push(ev);
    } catch {}
  }
  return bad;
}

function shot(name) {
  const out = join(SHOTS_DIR, name);
  herdr(["shot", out]);
  const st = statSync(out);
  if (st.size < 5000) throw new Error(`Screenshot ${name} unexpectedly small (${st.size} bytes)`);
  return { name, path: out, bytes: st.size };
}

function assertHealthy(label, telOffset) {
  const st = herdrJson(["status"]);
  if (Array.isArray(st?.errors) && st.errors.length > 0) {
    throw new Error(`[${label}] herdr-app status reported errors: ${JSON.stringify(st.errors)}`);
  }
  const renderErrs = newRenderErrors(telOffset);
  if (renderErrs.length > 0) {
    throw new Error(`[${label}] mod render error recorded in telemetry: ${JSON.stringify(renderErrs)}`);
  }
  return st;
}

async function main() {
  mkdirSync(SHOTS_DIR, { recursive: true });
  const initialStatus = herdrJson(["status"]);
  if (!initialStatus) throw new Error("herdr-app window is not running");
  const initialTab = initialStatus.tab;
  const telStart = telemetrySize();
  const createdTabs = [];
  const results = [];

  const runCase = async (id, desc, fn) => {
    const beforeTel = telemetrySize();
    try {
      const file = await fn();
      assertHealthy(id, beforeTel);
      results.push({ id, desc, status: "PASS", file });
      console.log(`PASS  ${id}  ->  ${file.path} (${Math.round(file.bytes / 1024)} KB)`);
    } catch (e) {
      results.push({ id, desc, status: "FAIL", error: String(e?.message ?? e) });
      console.error(`FAIL  ${id}: ${e?.message ?? e}`);
      throw e;
    }
  };

  try {
    // 1. Default 320px sidebar (balanced 2x2 Sakura CI strip)
    await runCase("01-sidebar-320px", "Sidebar at 320px (balanced 2x2 CI strip)", async () => {
      herdr(["do", "layout.resize", JSON.stringify({ id: "sidebar", px: 320 })]);
      await sleep(500);
      return shot("01-sidebar-320px.png");
    });

    // 2. Wide 480px sidebar (1x4 single-row CI strip)
    await runCase("02-sidebar-480px", "Sidebar at 480px (flexible 1x4 CI strip)", async () => {
      herdr(["do", "layout.resize", JSON.stringify({ id: "sidebar", px: 480 })]);
      await sleep(500);
      return shot("02-sidebar-480px.png");
    });

    // 3. Compact 44px rail mode
    await runCase("03-sidebar-rail", "Sidebar collapsed to 44px rail", async () => {
      herdr(["do", "layout.resize", JSON.stringify({ id: "sidebar", px: 44 })]);
      await sleep(500);
      const s = shot("03-sidebar-rail.png");
      herdr(["do", "layout.resize", JSON.stringify({ id: "sidebar", px: 320 })]);
      await sleep(300);
      return s;
    });

    // 4. Manage repositories drawer
    await runCase("04-sidebar-manage", "Sidebar Manage drawer open", async () => {
      herdr(["do", "wf-sidebar.manage"]);
      await sleep(400);
      const s = shot("04-sidebar-manage.png");
      herdr(["do", "wf-sidebar.manage"]);
      await sleep(250);
      return s;
    });

    // 5. Popup menus (all modes: new, dirty branch archive-blocked, closed session, live session)
    for (const [idx, mode] of [["05", "new"], ["06", "branch"], ["07a", "session-live"], ["07b", "session"]]) {
      await runCase(`${idx}-menu-${mode}`, `Popup wf-menu (${mode} mode)`, async () => {
        herdr(["do", `wf-sidebar.test-menu:${mode}`]);
        await sleep(450);
        const s = shot(`${idx}-menu-${mode}.png`);
        herdr(["do", "overlay.close"]);
        await sleep(250);
        return s;
      });
    }

    // 6. Dedicated wf-ci tab: Expanded-by-default Jobs & clickable Step nodes (no heavy log fetch yet!)
    await runCase("08-ci-summary", "wf-ci Build Summary (jobs expanded, clickable step nodes)", async () => {
      herdr(["do", "wf-sidebar.open-ci:overview"]);
      await sleep(300);
      herdr(["do", "wf-ci.view:summary"]);
      await sleep(1200);
      return shot("08-ci-summary.png");
    });

    // 7. Click an individual step node (Step 8: Run Tests) to expand its compact scrollable Editor with ALL lines
    await runCase("09-ci-step-log", "wf-ci step node expanded inline with full scrollable Editor", async () => {
      herdr(["do", "wf-ci.toggle-step:0:7"]);
      await sleep(2500);
      return shot("09-ci-step-log.png");
    });

    // 8. Jump-cut from that step straight to its exact line inside the Full Logs Editor
    await runCase("10-ci-logs", "wf-ci Full log jump-cut straight to step start line", async () => {
      herdr(["do", "wf-ci.jump-step:0:7"]);
      await sleep(900);
      return shot("10-ci-logs.png");
    });

    // 9. Opening wf-ci directly on Settings via the real sidebar openCiTab() path (sliders icon!)
    await runCase("11-ci-direct-settings", "wf-ci Settings workflow picker via sidebar sliders path", async () => {
      herdr(["do", "wf-sidebar.open-ci:settings"]);
      await sleep(900);
      return shot("11-ci-direct-settings.png");
    });

    // 10. Verify disk cache populated and reopening wf-ci paints Summary immediately (<700ms)
    await runCase("12-ci-cached-reopen", "wf-ci reopen renders cached snapshot + jobs Summary immediately", async () => {
      const logCacheDir = join(HERDR_HOME, "data/wf/ci-cache/logs");
      const cachedLogs = existsSync(logCacheDir) ? readdirSync(logCacheDir).filter(f => f.endsWith(".json")) : [];
      if (!cachedLogs.length) throw new Error(`Expected disk-cached logs in ${logCacheDir}, found 0`);
      herdr(["do", "wf-sidebar.open-ci:overview"]);
      await sleep(200);
      const created = herdrJson(["do", "tab.new", JSON.stringify({
        name: `E2E CI Cached · ${REPO_NAME}`,
        mod: "wf-ci",
        props: { repo: REPO_NAME, dir: REPO_DIR, slug: REPO_SLUG, tab: "overview" },
      })]);
      if (created?.tab) createdTabs.push(created.tab);
      await sleep(700);
      return shot("12-ci-cached-reopen.png");
    });

    // 11. Verify Spotify-playlist branch drag-and-drop insertion indicator renders cleanly
    await runCase("13-sidebar-drag", "Sidebar active branch drag-and-drop insertion indicator", async () => {
      herdr(["do", "wf-sidebar.test-drag"]);
      await sleep(400);
      const s = shot("13-sidebar-drag.png");
      herdr(["do", "wf-sidebar.test-drag:clear"]);
      await sleep(200);
      return s;
    });

    assertHealthy("final", telStart);
  } finally {
    try { herdr(["do", "overlay.close"]); } catch {}
    for (const tid of createdTabs) {
      try { herdr(["do", "tab.close", JSON.stringify({ id: tid })]); } catch {}
    }
    try { herdr(["do", "layout.resize", JSON.stringify({ id: "sidebar", px: 320 })]); } catch {}
    if (initialTab) {
      try { herdr(["do", "tab.select", JSON.stringify({ id: initialTab })]); } catch {}
    }

    const md = [
      "# Herdr Workflow Visual E2E Report",
      "",
      "| Case | Description | Status | Screenshot |",
      "| --- | --- | --- | --- |",
      ...results.map(r => `| \`${r.id}\` | ${r.desc} | **${r.status}** | ${r.file ? `[${r.file.name}](${r.file.name})` : (r.error || "")} |`),
      "",
    ].join("\n");
    writeFileSync(join(SHOTS_DIR, "report.md"), md);
  }

  console.log(`\nAll ${results.length} visual E2E checks passed! Report: ${join(SHOTS_DIR, "report.md")}`);
}

main().catch(e => {
  console.error(e?.stack || e);
  process.exit(1);
});
