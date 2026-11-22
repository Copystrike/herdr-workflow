// Where Claude Code keeps things for a folder. Mirrors Claude Code's own rule (2.1.x):
// every character outside [A-Za-z0-9] becomes "-"; names over 200 characters are cut at 200
// and get "-" + base36 of a 31-multiplier hash of the ORIGINAL path appended.

const MAX = 200;

export function hash31(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h;
}

export function claudeProjectDirName(path) {
  const name = path.replace(/[^a-zA-Z0-9]/g, "-");
  if (name.length <= MAX) return name;
  return `${name.slice(0, MAX)}-${Math.abs(hash31(path)).toString(36)}`;
}

// Candidate transcript folders for a cwd: the stored path and, when different, the resolved one.
export function claudeProjectDirs(configDir, path, resolvedPath) {
  const names = new Set([claudeProjectDirName(path)]);
  if (resolvedPath && resolvedPath !== path) names.add(claudeProjectDirName(resolvedPath));
  return [...names].map(n => `${configDir}/projects/${n}`);
}

export const scratchpadRoot = (uid, path, tmp = "/tmp") => `${tmp}/claude-${uid}/${claudeProjectDirName(path)}`;

export const basename = p => p.replace(/\/+$/, "").split("/").pop();
export const dirname = p => p.replace(/\/+$/, "").split("/").slice(0, -1).join("/") || "/";
export const join = (...parts) => parts.filter(Boolean).join("/").replace(/\/{2,}/g, "/");
