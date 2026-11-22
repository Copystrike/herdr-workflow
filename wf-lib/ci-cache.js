// Two-tier (in-memory + disk) cache for GitHub Actions CI snapshots, jobs, and logs.
// Completed runs/jobs are immutable per (runId, attempt); running/queued runs are never cached.

const CACHEABLE_STATES = new Set(["passed", "failed", "cancelled", "skipped"]);

export const isCacheableState = state => CACHEABLE_STATES.has(String(state || "").toLowerCase());

export function safeSlug(slug) {
  return String(slug || "unknown").replace(/[^a-zA-Z0-9._-]+/g, "_");
}

export function logCacheKey({ slug, runId, jobId = null, failedOnly = false, attempt = 1 }) {
  const scope = jobId ? `j${jobId}` : (failedOnly ? "all_failed" : "all_full");
  return `${safeSlug(slug)}__r${runId}__${scope}__a${attempt || 1}`;
}

export function jobsCacheKey({ slug, runId, attempt = 1 }) {
  return `${safeSlug(slug)}__r${runId}__a${attempt || 1}`;
}

// Picks the most useful single job to show first (failed -> active -> first non-skipped)
// so we fetch one lightweight job log instead of downloading every job's zip archive.
export function pickDefaultJob(jobs) {
  if (!Array.isArray(jobs) || !jobs.length) return null;
  return jobs.find(j => j.state === "failed")
    ?? jobs.find(j => j.state === "running" || j.state === "queued")
    ?? jobs.find(j => j.state !== "skipped")
    ?? jobs[0];
}

export function createCiCache({ fs, dir, maxLogs = 80 } = {}) {
  const memSnapshots = new Map();
  const memJobs = new Map();
  const memLogs = new Map();
  let dirsReady = false;

  const ensureDirs = async () => {
    if (dirsReady || !fs || !dir) return;
    dirsReady = true;
    await Promise.all([
      fs.mkdir(`${dir}/snapshots`, { recursive: true }).catch(() => {}),
      fs.mkdir(`${dir}/jobs`, { recursive: true }).catch(() => {}),
      fs.mkdir(`${dir}/annotations`, { recursive: true }).catch(() => {}),
      fs.mkdir(`${dir}/logs`, { recursive: true }).catch(() => {}),
    ]);
  };

  const readJson = async file => {
    if (!fs || !dir) return null;
    try { return JSON.parse(await fs.readFile(file, "utf8")); }
    catch { return null; }
  };

  // Uses only fs/promises methods supported by both Node and Herdr's QuickJS host:
  // mkdir, readFile, writeFile, readdir, unlink (no fs.rename / fs.stat).
  const writeJson = async (file, value) => {
    if (!fs || !dir) return;
    await ensureDirs();
    try {
      await fs.writeFile(file, JSON.stringify(value), "utf8");
    } catch { /* ignore transient write errors */ }
  };

  const pruneDir = async (sub, limit) => {
    if (!fs || !dir) return;
    try {
      const folder = `${dir}/${sub}`;
      const names = (await fs.readdir(folder)).filter(n => n.endsWith(".json"));
      if (names.length <= limit) return;
      // Sort lexicographically by runId/filename descending (GitHub run IDs increase monotonically),
      // keeping the newest `limit` files without needing fs.stat.
      names.sort((a, b) => b.localeCompare(a));
      for (const old of names.slice(limit)) {
        await fs.unlink(`${folder}/${old}`).catch(() => {});
      }
    } catch { /* ignore pruning errors */ }
  };

  return {
    async getSnapshot(slug) {
      if (!slug) return null;
      const k = safeSlug(slug);
      if (memSnapshots.has(k)) return memSnapshots.get(k);
      const disk = await readJson(`${dir}/snapshots/${k}.json`);
      if (disk) memSnapshots.set(k, disk);
      return disk;
    },

    async setSnapshot(slug, snap) {
      if (!slug || !snap) return;
      const k = safeSlug(slug);
      memSnapshots.set(k, snap);
      await writeJson(`${dir}/snapshots/${k}.json`, snap);
    },

    async getJobs(slug, runId, attempt = 1) {
      const k = jobsCacheKey({ slug, runId, attempt });
      if (memJobs.has(k)) return memJobs.get(k);
      const disk = await readJson(`${dir}/jobs/${k}.json`);
      if (Array.isArray(disk)) {
        memJobs.set(k, disk);
        return disk;
      }
      return null;
    },

    async setJobs(slug, runId, attempt = 1, jobs) {
      if (!Array.isArray(jobs)) return;
      const k = jobsCacheKey({ slug, runId, attempt });
      memJobs.set(k, jobs);
      await writeJson(`${dir}/jobs/${k}.json`, jobs);
      pruneDir("jobs", maxLogs * 2);
    },

    async getAnnotations(slug, jobId) {
      const k = `${safeSlug(slug)}__j${jobId}`;
      if (memJobs.has(`ann:${k}`)) return memJobs.get(`ann:${k}`);
      const disk = await readJson(`${dir}/annotations/${k}.json`);
      if (Array.isArray(disk)) {
        memJobs.set(`ann:${k}`, disk);
        return disk;
      }
      return null;
    },

    async setAnnotations(slug, jobId, list) {
      if (!Array.isArray(list)) return;
      const k = `${safeSlug(slug)}__j${jobId}`;
      memJobs.set(`ann:${k}`, list);
      await writeJson(`${dir}/annotations/${k}.json`, list);
      pruneDir("annotations", maxLogs * 2);
    },

    async getLog(opts) {
      const k = typeof opts === "string" ? opts : logCacheKey(opts);
      if (memLogs.has(k)) return { ...memLogs.get(k), cached: true };
      const disk = await readJson(`${dir}/logs/${k}.json`);
      if (disk && typeof disk.text === "string") {
        memLogs.set(k, disk);
        return { ...disk, cached: true };
      }
      return null;
    },

    async setLog(opts, entry) {
      if (!entry || entry.error || typeof entry.text !== "string") return;
      const k = typeof opts === "string" ? opts : logCacheKey(opts);
      const stored = {
        text: entry.text,
        truncated: Boolean(entry.truncated),
        totalLines: entry.totalLines ?? 0,
        error: null,
        fetchedAt: Date.now(),
      };
      memLogs.set(k, stored);
      await writeJson(`${dir}/logs/${k}.json`, stored);
      pruneDir("logs", maxLogs);
    },
  };
}
