// src/read.js
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import chalk from "chalk";
import { checkOllama } from "./ollama.js";
import { buildIgnoreList, scanRepo } from "./scan.js";
import { readIndex, writeIndex, dropFilesFromIndex, embedFile } from "./embeddings.js";

function findRepoRoot(cwd = process.cwd()) {
  let dir = cwd;
  while (true) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return cwd; // fallback
    dir = parent;
  }
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writeFileIfMissing(p, contents, overwrite = false) {
  if (!fs.existsSync(p) || overwrite) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, contents, "utf8");
    return true;
  }
  return false;
}

function loadJSONSafe(p) {
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {}
  return null;
}

export async function readCommand({ force = false, silent = false } = {}) {

  const log = (...a) => { if (!silent) console.log(...a); };
  const root = findRepoRoot();
  const dot = path.join(root, ".devforge");
  const cfgPath = path.join(dot, "config.json");
  const ignorePath = path.join(dot, "ignore");
  const manifestPath = path.join(dot, "manifest.json");
  const indexPath = path.join(dot, "index.json");

  if (force) {
    log(chalk.yellow("🔥 --force: Clearing cache (keeping your settings)"));
    
    [manifestPath, indexPath].forEach(filePath => {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        log(chalk.gray(`   ✓ Deleted ${path.basename(filePath)}`));
      }
    });
  }

  // ---- Step 1: Preflight (Ollama + models) ----
  const existingCfg = loadJSONSafe(cfgPath);
  const chatModel   = existingCfg?.models?.chat  || "gemma3:latest";
  const embedModel  = existingCfg?.models?.embed || "nomic-embed-text:latest";

  log(chalk.cyan("🔎 Preflight: Ollama & models"));
  try {
    await checkOllama([chatModel, embedModel]);
    log(chalk.green("✅ Ollama running, required models found."));
  } catch (err) {
    console.error(chalk.red(`✖ ${err.message}`));
    process.exit(1);
  }

  // ---- Step 2: Initialize .devforge (config & ignore) ----
  log(chalk.cyan(`🔧 Initializing DevForge at: ${dot}`));
  ensureDir(dot);

const defaultConfig = {
  airgap: false,
  max_file_kb: 256,
  models: { chat: "gemma3:latest", embed: "nomic-embed-text:latest" },
  paths: {
    include: ["**/*"],  // ← Include all files and directories recursively
    exclude: [
      // Development artifacts
      "node_modules/**", 
      "dist/**", 
      "build/**",
      ".git/**", 
      ".svn/**",
      ".hg/**",
      
      // Package manager files
      "*.lock",
      "package-lock.json",
      "yarn.lock",
      "pnpm-lock.yaml",
      
      // Binary and media files
      "*.bin",
      "*.exe", 
      "*.dll",
      "*.so",
      "*.dylib",
      "*.jpg", 
      "*.jpeg",
      "*.png", 
      "*.gif",
      "*.bmp",
      "*.ico",
      "*.pdf",
      "*.zip",
      "*.tar.gz",
      "*.rar",
      "*.7z",
      
      // Environment and secrets
      ".env",
      ".env.*",
      "**/*.key",
      "**/*.pem",
      "**/*.p12",
      "**/*.pfx",
      "id_*",
      "*.crt",
      "*.csr",
      
      // IDE and editor files
      ".vscode/**",
      ".idea/**",
      "*.swp",
      "*.swo",
      "*~",
      ".DS_Store",
      "Thumbs.db",
      
      // Logs and temporary files
      "*.log",
      "logs/**",
      "tmp/**",
      "temp/**",
      ".tmp/**",
      
      // Cache directories
      ".cache/**",
      ".next/**",
      ".nuxt/**",
      "coverage/**",
      ".nyc_output/**"
    ]
  },
  retrieval: { bm25_k: 80, vec_k: 80, final_k: 20 },
  policies: { edit_allow: ["src/**"], edit_deny: ["config/**"], allow_exec: ["npm test"] },
  created_at: new Date().toISOString()
};

  const cfg = existingCfg || defaultConfig;

  const wroteCfg = writeFileIfMissing(cfgPath, JSON.stringify(cfg, null, 2), false);
  const defaultIgnore = [
    "node_modules/**",
    "dist/**",
    ".git/**",
    "*.lock",
    "*.bin",
    "*.jpg",
    "*.png",
    "*.pdf",
    ".env",
    "**/*.key",
    "**/*.pem",
    "id_*"
  ].join(os.EOL);
  const wroteIgnore = writeFileIfMissing(ignorePath, defaultIgnore, false);

  log(
    wroteCfg
      ? chalk.green(`✅ Created ${path.relative(root, cfgPath)}`)
      : chalk.gray(`ℹ️  ${path.relative(root, cfgPath)} exists (use --force to overwrite)`)
  );
  log(
    wroteIgnore
      ? chalk.green(`✅ Created ${path.relative(root, ignorePath)}`)
      : chalk.gray(`ℹ️  ${path.relative(root, ignorePath)} exists (use --force to overwrite)`)
  );

  // ---- Step 3: Scan & Manifest with Hashes + Delta Summary ----
  log(chalk.cyan("📚 Scanning repository (respecting config & ignore)…"));

  const ignoreList = buildIgnoreList(root, cfg, ignorePath);
  const include = cfg?.paths?.include?.length ? cfg.paths.include : ["**/*"];
  const maxKB = Number(cfg?.max_file_kb || 256);

  const prevManifest = loadJSONSafe(manifestPath);
  const prevMap = new Map((prevManifest?.files_with_hashes || []).map(f => [f.path, f.hash]));

  const { files, languages } = await scanRepo({ root, include, exclude: ignoreList, maxFileKB: maxKB });

  // Compute deltas with file lists
  const currentMap = new Map(files.map(f => [f.path, f.hash]));
  const addedFiles = [];
  const changedFiles = [];
  const removedFiles = [];

  for (const f of files) {
    if (!prevMap.has(f.path)) addedFiles.push(f);
    else if (prevMap.get(f.path) !== f.hash) changedFiles.push(f);
  }
  if (prevManifest?.files_with_hashes) {
    for (const pf of prevManifest.files_with_hashes) {
      if (!currentMap.has(pf.path)) removedFiles.push(pf.path);
    }
  }

  const manifest = {
    root,
    files_total: files.length,
    files_with_hashes: files, // [{ path, sizeKB, hash }]
    languages,
    max_file_kb: maxKB,
    models: cfg.models,
    created_at: new Date().toISOString()
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  const langStr = Object.entries(languages).map(([k, v]) => `${k}(${v})`).join(", ") || "n/a";

  if (prevManifest) {
    log(chalk.green(`✅ Refreshed manifest: ${files.length} files`));
    log(chalk.gray(`   Δ changes → added: ${addedFiles.length}, changed: ${changedFiles.length}, removed: ${removedFiles.length}`));
    if (addedFiles.length) { log(chalk.green("   ➕ Added:")); addedFiles.forEach(f => log("     " + f.path)); }
    if (changedFiles.length) { log(chalk.yellow("   ✏️ Changed:")); changedFiles.forEach(f => log("     " + f.path)); }
    if (removedFiles.length) { log(chalk.red("   ❌ Removed:")); removedFiles.forEach(f => log("     " + f)); }
  } else {
    log(chalk.green(`✅ Created manifest: ${files.length} files`));
  }
  log(chalk.gray(`   Languages: ${langStr}`));
  log(chalk.gray(`   Saved: ${path.relative(root, manifestPath)}`));

  // ---- Step 4: Embeddings for added/changed files & pruning removed ----
  log(chalk.cyan("🧠 Embedding repo content (added/changed files only)…"));
  const index = readIndex(indexPath);

  // prune removed files from index
  if (removedFiles.length) {
    const before = index.chunks.length;
    const pruned = before - (dropFilesFromIndex(index, removedFiles).chunks.length);
    if (pruned > 0) log(chalk.gray(`   Pruned ${pruned} stale chunks from index`));
  }

  let totalNewChunks = 0;
  const toProcess = [...addedFiles, ...changedFiles];

  for (let i = 0; i < toProcess.length; i++) {
    const f = toProcess[i];
    const progress = `${i + 1}/${toProcess.length}`;
    try {
      process.stdout.write(chalk.gray(`   · (${progress}) ${f.path} … `));
      const { added } = await embedFile({ root, file: f, model: embedModel, index });
      totalNewChunks += added;
      process.stdout.write(chalk.green(`ok (${added} chunks)\n`));
    } catch (e) {
      process.stdout.write(chalk.red(`fail\n`));
      console.error(chalk.red(`     └─ ${e.message || e}`));
    }
  }

  writeIndex(indexPath, index);

  if (toProcess.length === 0) {
    log(chalk.gray("   No files changed — embeddings are up to date."));
  } else {
    log(chalk.green(`✅ Embedded ${toProcess.length} file(s), ${totalNewChunks} chunk(s)`));
    log(chalk.gray(`   Saved: ${path.relative(root, indexPath)}`));
  }

  log(chalk.white(`
Next:
  • Ask a question with: devforge chat "where is JWT verified?"
  • If you add/modify files, run: devforge read (incremental embeddings will update)
`));
}
