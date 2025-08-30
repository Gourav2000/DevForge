// src/chat.js
import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import fetch from "node-fetch";

const OLLAMA_URL = "http://127.0.0.1:11434";

function findRepoRoot(cwd = process.cwd()) {
  let dir = cwd;
  while (true) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return cwd;
    dir = parent;
  }
}

function loadJSON(p, fallback = null) {
  try { if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8")); }
  catch {}
  return fallback;
}

async function embedText(model, text) {
  const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, prompt: text })
  });
  if (!res.ok) throw new Error("Embedding request failed");
  const data = await res.json();
  return data?.embedding;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

function readSlice(absPath, start, end) {
  const txt = fs.readFileSync(absPath, "utf8");
  const lines = txt.split(/\r?\n/);
  const s = Math.max(0, start|0);
  const e = Math.min(lines.length, end|0);
  return lines.slice(s, e).join("\n");
}

async function chatWithContext(model, question, contextBlocks, maxTokens) {
  const sys = [
    "You are DevForge, a local-first repo assistant.",
    "Answer using only the provided context. If unsure, say you don't know.",
    "Cite sources in the format [path:start-end]."
  ].join(" ");

  const ctx = contextBlocks.map(b =>
    `# Source: ${b.path}:${b.start}-${b.end}\n${b.text}`
  ).join("\n\n----\n\n");

  const prompt = `${sys}\n\n# Question\n${question}\n\n# Context\n${ctx}\n\n# Answer`;

  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      options: { num_predict: Number(maxTokens) || 512 }
    })
  });
  if (!res.ok) throw new Error("Chat request failed");
  // Stream or full—Ollama may stream; simplest is to read text() then parse chunks if needed.
  const text = await res.text();
  // If server streams JSONL, pick the last content chunk:
  const lines = text.trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  let out = "";
  for (const ln of lines) {
    try { const j = JSON.parse(ln); if (j?.message?.content) out += j.message.content; }
    catch { /* ignore */ }
  }
  return out || text;
}

export async function chatCommand({ question, topk = "12", maxTokens = "512", model, showSources = false }) {
  const root = findRepoRoot();
  const dot = path.join(root, ".devforge");
  const cfg = loadJSON(path.join(dot, "config.json"), {});
  const index = loadJSON(path.join(dot, "index.json"), { chunks: [] });

  const embedModel = cfg?.models?.embed || "nomic-embed-text:latest";
  const chatModel  = model || cfg?.models?.chat || "gemma3:latest";
  const k = Math.max(1, Number(topk) || 12);

  if (!index.chunks?.length) {
    console.log(chalk.red("No vectors found. Run `devforge read` first."));
    return;
  }

  process.stdout.write(chalk.cyan("🔎 Retrieving relevant code… "));
  const qVec = await embedText(embedModel, question);

  // Score chunks
  const scored = [];
  for (const c of index.chunks) {
    if (!Array.isArray(c.vector)) continue;
    const score = cosine(qVec, c.vector);
    const freshnessBoost = c.updated_at ? 1e-6 : 0;
    scored.push({ score: score + freshnessBoost, ...c });
  }
  scored.sort((a,b) => b.score - a.score);

  // Deduplicate by file, keep best chunk per file first, then fill up to k
  const byFile = new Map();
  for (const s of scored) {
    if (!byFile.has(s.path)) byFile.set(s.path, []);
    byFile.get(s.path).push(s);
  }
  const pick = [];
  for (const [p, arr] of byFile) {
    arr.sort((a,b)=>b.score-a.score);
    pick.push(arr[0]);
    if (pick.length >= k) break;
  }
  while (pick.length < k && pick.length < scored.length) pick.push(scored[pick.length]);

  // Build context blocks
  const ctx = [];
  for (const c of pick.slice(0, k)) {
    const abs = path.join(root, c.path);
    let text = "";
    try { text = readSlice(abs, c.start, c.end); }
    catch {}
    ctx.push({ path: c.path, start: c.start, end: c.end, text });
  }
  console.log(chalk.green(`ok (${ctx.length} chunk(s))`));

  const answer = await chatWithContext(chatModel, question, ctx, maxTokens);
  console.log("\n" + answer.trim() + "\n");

  if (showSources) {
    console.log(chalk.gray("\nSources:"));
    for (const c of ctx) {
      console.log(chalk.gray(`  - ${c.path}:${c.start}-${c.end}`));
    }
  }
}
