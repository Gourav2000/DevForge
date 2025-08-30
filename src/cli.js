// src/cli.js
import { Command } from "commander";
import chalk from "chalk";
import { readCommand } from "./read.js";
import { chatCommand } from "./chat.js"; // ⬅️ add

const program = new Command();

program
  .name("devforge")
  .description("Local-first AI dev assistant (powered by Ollama)")
  .version("0.1.0");

program
  .command("hello")
  .description("Say hello")
  .action(() => console.log(chalk.green("👋 Hello from DevForge!")));

program
  .command("read")
  .description("Preflight Ollama+models, then init .devforge (config & ignore)")
  .option("--force", "Overwrite existing files", false)
  .action(async (opts) => {
    await readCommand({ force: !!opts.force });
  });

program
  .command("ask <question...>")
  .description("Refresh context (scan+embeddings) then answer your question")
  .option("--no-refresh", "skip context refresh (use existing index.json)")
  .option("-k, --topk <n>", "number of chunks to retrieve", "12")
  .option("--max-tokens <n>", "max tokens for answer", "512")
  .option("--model <name>", "chat model override")
  .option("--show-sources", "print sources at the end", false)
  .action(async (questionParts, opts) => {
    const q = questionParts.join(" ");
    if (opts.refresh !== false) {
      // fast, incremental: only added/changed files are embedded
      await readCommand({ force: false, silent: true });
    }
    await chatCommand({ question: q, ...opts });
  });

program.parse(process.argv);