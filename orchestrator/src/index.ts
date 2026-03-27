import "dotenv/config";
import { App, LogLevel } from "@slack/bolt";
import { loadConfig } from "./config";
import { Registry } from "./registry";
import { K8sClient } from "./k8s-client";
import { UserLock } from "./user-lock";
import { createHandler } from "./commands/create";
import { destroyHandler } from "./commands/destroy";
import { statusHandler } from "./commands/status";
import { configRetentionHandler } from "./commands/config-retention";
import { exportHandler } from "./commands/export";
import { joinHandler } from "./commands/join";
import { startOrphanDetector } from "./orphan-detector";
import { startEventGateway } from "./event-gateway";
import { startTokenRotation } from "./token-rotation";

async function main() {
  const config = loadConfig();
  const registry = new Registry(config.databasePath);
  const k8sClient = new K8sClient(config);
  const userLock = new UserLock();

  const app = new App({
    token: config.slackBotToken,
    appToken: config.slackAppToken,
    socketMode: true,
    logLevel: LogLevel.INFO,
  });

  // Route /harrybotter <subcommand>
  app.command("/harrybotter", async (args) => {
    const rawText = (args.command.text || "").trim().toLowerCase();
    const subcommand = rawText.split(/\s+/)[0];

    switch (subcommand) {
      case "create":
        return createHandler(config, registry, k8sClient, userLock)(args);
      case "destroy":
        return destroyHandler(config, registry, k8sClient, userLock)(args);
      case "status":
        return statusHandler(config, registry, k8sClient)(args);
      case "config":
        return configRetentionHandler(config, registry)(args);
      case "export":
        return exportHandler(config, registry)(args);
      case "join":
        return joinHandler(config, registry)(args);
      default:
        await args.ack();
        await args.respond({
          response_type: "ephemeral",
          text: [
            `🧙 *Harry Botter Commands*`,
            ``,
            `\`/harrybotter create\` — Create your personal bot instance`,
            `\`/harrybotter destroy\` — Destroy your bot instance`,
            `\`/harrybotter status\` — Check your bot's status`,
            `\`/harrybotter join #channel\` — Add your bot to a channel`,
            `\`/harrybotter export\` — Export your data (manual backup)`,
            `\`/harrybotter config retention retain|delete\` — Set data retention mode`,
          ].join("\n"),
        });
    }
  });

  await app.start();
  console.log("⚡ Harry Botter Orchestrator is running (Socket Mode)");

  // Start token rotation for App Configuration Token
  const stopTokenRotation = startTokenRotation(config, registry);

  // Start HTTP event gateway for per-user apps
  const gateway = startEventGateway({ config, registry });
  console.log(`⚡ Event Gateway public URL: ${config.eventGatewayUrl}`);

  // Start orphan detector (every 5 minutes)
  const autoCleanup = process.env.ORPHAN_AUTO_CLEANUP === "true";
  const stopOrphanDetector = startOrphanDetector(k8sClient, registry, {
    intervalMs: 5 * 60 * 1000,
    autoCleanup,
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log("Shutting down...");
    stopTokenRotation();
    gateway.close();
    stopOrphanDetector();
    registry.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
