import { validateMatrixConfig } from "./config.js";
import { MatrixConnector } from "./connectors/matrix.js";

async function main() {
  validateMatrixConfig();

  const connector = new MatrixConnector();

  await connector.start();
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
