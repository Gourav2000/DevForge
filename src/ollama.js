// src/ollama.js
import fetch from "node-fetch";

const OLLAMA_URL = "http://127.0.0.1:11434";

export async function checkOllama(requiredModels = []) {
  // 1) Is server up?
  let data;
  try {
    const res = await fetch(OLLAMA_URL + "/api/tags");
    if (!res.ok) throw new Error();
    data = await res.json();
  } catch {
    throw new Error("Ollama is not running at 127.0.0.1:11434. Start it with: `ollama serve`");
  }

  // 2) Are models present?
  const installed = Array.isArray(data.models) ? data.models.map(m => m.name) : [];
  const missing = requiredModels.filter(m => !installed.includes(m));
  if (missing.length) {
    const pulls = missing.map(m => `ollama pull ${m}`).join("\n  ");
    throw new Error(
      `Missing model(s): ${missing.join(", ")}\n` +
      `Run:\n  ${pulls}`
    );
  }
  return true;
}
