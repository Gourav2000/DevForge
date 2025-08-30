// src/scan.js
import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import crypto from "node:crypto";

/**
 * Build ignore list from config + .devforge/ignore
 */
export function buildIgnoreList(root, cfg, ignorePath) {
  const extraIgnores = fs.existsSync(ignorePath)
    ? fs.readFileSync(ignorePath, "utf8")
        .split(/\r?\n/)
        .map(s => s.trim())
        .filter(Boolean)
    : [];
  return [...(cfg?.paths?.exclude || []), ...extraIgnores];
}

/**
 * SHA-256 file hash (small & simple; reads whole file into memory)
 * For very large repos, switch to a streaming hash.
 */
function hashFileFull(filepath) {
  const buf = fs.readFileSync(filepath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * Scan files using include/exclude globs.
 * Returns { files, languages } where files have { path, sizeKB, hash }.
 */
export async function scanRepo({ root, include = ["**/*"], exclude = [], maxFileKB = 256 }) {
  const relPaths = await fg(include, {
    cwd: root,
    ignore: exclude,
    dot: false,
    onlyFiles: true,
    absolute: false
  });

  const files = [];
  const languages = {};
  for (const rel of relPaths) {
    const full = path.join(root, rel);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    const sizeKB = Math.ceil(stat.size / 1024);
    if (sizeKB > maxFileKB) continue;

    const hash = hashFileFull(full);
    files.push({ path: rel, sizeKB, hash });

    const ext = (rel.split(".").pop() || "").toLowerCase();
    if (ext) languages[ext] = (languages[ext] || 0) + 1;
  }
  return { files, languages };
}
