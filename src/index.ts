import { validateMatrixConfig } from "./config.js";
import { Orchestrator } from "./orchestrator.js";
import { MatrixConnector } from "./connectors/matrix.js";
import { startWatcher } from "./watcher.js";

async function main() {
  validateMatrixConfig();

  const orchestrator = new Orchestrator();
  const connector = new MatrixConnector(orchestrator);

  await connector.start();
  startWatcher();
  console.log("[betabot] Running. Press Ctrl+C to stop.");

  process.on("SIGTERM", () => {
    console.log("[betabot] Shutting down…");
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("[betabot] Fatal error:", err);
  process.exit(1);
});
