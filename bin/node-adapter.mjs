// herdr's exec/fs shapes on top of node, for the wf CLI and the tests.
import { execFile } from "node:child_process";
import * as nodeFs from "node:fs/promises";

export function exec(cmd, args = [], { cwd, timeout = 30000 } = {}) {
  return new Promise(resolve => {
    execFile(cmd, args, { cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

export const fs = {
  readFile: (p, enc) => nodeFs.readFile(p, enc),
  readdir: (p, opts) => nodeFs.readdir(p, opts),
  exists: p => nodeFs.access(p).then(() => true, () => false),
};
