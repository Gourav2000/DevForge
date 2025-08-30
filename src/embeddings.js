// src/embeddings.js
import fs from "node:fs";
import path from "node:path";
import fetch from "node-fetch";

const OLLAMA = "http://127.0.0.1:11434";

/** Read or init the vector index JSON. */
export function readIndex(indexPath) {
  try {
    if (fs.existsSync(indexPath)) {
      return JSON.parse(fs.readFileSync(indexPath, "utf8"));
    }
  } catch {}
  return { version: 1, chunks: [] }; // chunks: [{ path, hash, chunkId, start, end, vector }]
}

/** Persist the vector index JSON. */
export function writeIndex(indexPath, data) {
  fs.writeFileSync(indexPath, JSON.stringify(data, null, 2), "utf8");
}

/** Remove all chunks for given file paths (e.g., removed files). */
export function dropFilesFromIndex(index, removedPaths = []) {
  if (!removedPaths.length) return index;
  const rm = new Set(removedPaths);
  index.chunks = index.chunks.filter((c) => !rm.has(c.path));
  return index;
}

/** Remove chunks for a given file hash mismatch (we'll reinsert fresh). */
export function dropFileFromIndexByPath(index, pathStr) {
  index.chunks = index.chunks.filter((c) => c.path !== pathStr);
  return index;
}

/** Simple line-based chunker (keeps things deterministic & fast). */
export function chunkFileContent(text, { maxChars = 2000, overlap = 200 } = {}) {
  // Split into lines, then pack into windows ~maxChars with small overlap.
  const lines = text.split(/\r?\n/);
  const chunks = [];
  let start = 0;
  while (start < lines.length) {
    let end = start;
    let size = 0;
    while (end < lines.length && size + lines[end].length + 1 <= maxChars) {
      size += lines[end].length + 1;
      end++;
    }
    const slice = lines.slice(start, end);
    if (slice.length) {
      chunks.push({
        text: slice.join("\n"),
        start,            // start line (0-based)
        end: end - 1      // end line
      });
    }
    if (end >= lines.length) break;
    start = Math.max(end - Math.floor(overlap / 80), end - 3); // small line overlap heuristic
  }
  return chunks;
}

/** Call Ollama embeddings API for an array of texts (batched). */
export async function embedTexts(model, texts, { batchSize = 10 } = {}) {
  console.log(`🔍 Embedding ${texts.length} texts with model: ${model} (sequential processing)`);
  
  if (!texts.length) {
    console.warn("⚠️  No texts provided for embedding");
    return [];
  }

  const vectors = [];
  
  // Process in smaller batches to show progress and prevent overwhelming the server
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(texts.length / batchSize);
    
    console.log(`📦 Processing batch ${batchNum}/${totalBatches} (${batch.length} texts)`);
    
    // Process each text in the batch sequentially
    for (let j = 0; j < batch.length; j++) {
      const text = batch[j];
      const globalIndex = i + j + 1;
      
      try {
        // Show progress for individual texts within batch
        process.stdout.write(`   ${globalIndex}/${texts.length}: `);
        
        const res = await fetch(`${OLLAMA}/api/embeddings`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ 
            model, 
            prompt: text // Use 'prompt' not 'input'
          })
        });

        if (!res.ok) {
          const errorText = await res.text().catch(() => "");
          process.stdout.write(`❌ failed\n`);
          throw new Error(`Embeddings API failed (HTTP ${res.status}): ${errorText}`);
        }

        const data = await res.json();
        
        // Validate response
        if (!data.embedding || !Array.isArray(data.embedding)) {
          process.stdout.write(`❌ invalid response\n`);
          throw new Error("Invalid embedding response format");
        }

        vectors.push(data.embedding);
        process.stdout.write(`✅ ok\n`);

        // Small delay to avoid overwhelming Ollama
        if (j < batch.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }

      } catch (error) {
        process.stdout.write(`❌ error: ${error.message}\n`);
        throw error;
      }
    }
    
    console.log(`✅ Batch ${batchNum} completed (${vectors.length}/${texts.length} total)`);
    
    // Longer delay between batches
    if (i + batchSize < texts.length) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  console.log(`🎯 Successfully created ${vectors.length} embeddings`);
  return vectors;
}

/** Upsert embeddings for a single file (chunks). */
export async function embedFile({ root, file, model, index }) {
  const full = path.join(root, file.path);
  const text = fs.readFileSync(full, "utf8");
  const chunks = chunkFileContent(text);

  if (!chunks.length) return { added: 0 };

  const vectors = await embedTexts(model, chunks.map((c) => c.text));

  // Remove any previous chunks for this path (fresh upsert)
  dropFileFromIndexByPath(index, file.path);

  // Insert new chunks
  for (let i = 0; i < chunks.length; i++) {
    index.chunks.push({
      path: file.path,
      hash: file.hash,
      chunkId: i,
      start: chunks[i].start,
      end: chunks[i].end,
      vector: vectors[i],
      updated_at: new Date().toISOString() 
    });
  }
  return { added: chunks.length };
}
