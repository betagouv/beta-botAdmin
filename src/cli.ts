/**
 * Local CLI client — interact with the bot without Matrix.
 * Usage: npm run cli
 */
import readline from "readline";
import { Orchestrator } from "./orchestrator.js";

const orchestrator = new Orchestrator();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "vous > ",
});

console.log("betabot CLI — tapez votre question (Ctrl+C pour quitter)");
console.log("(debug logs on stderr — run with: npm run cli 2>&1 | cat  to interleave them)\n");
rl.prompt();

rl.on("line", async (line) => {
  const text = line.trim();
  if (!text) {
    rl.prompt();
    return;
  }

  try {
    const response = await orchestrator.handle({
      userId: "local-user",
      roomId: "cli",
      text,
    });
    console.log(`\nbetabot > ${response}\n`);
    orchestrator.clearHistory("cli");
  } catch (err) {
    console.error("Erreur:", err);
  }

  rl.prompt();
});

rl.on("close", () => {
  process.exit(0);
});
