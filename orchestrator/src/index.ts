import { App, LogLevel } from "@slack/bolt";
import { loadConfig } from "./config";
import { Registry } from "./registry";
import { createHandler } from "./commands/create";
import { destroyHandler } from "./commands/destroy";
import { statusHandler } from "./commands/status";

async function main() {
  const config = loadConfig();
  const registry = new Registry(config.databasePath);

  const app = new App({
    token: config.slackBotToken,
    appToken: config.slackAppToken,
    socketMode: true,
    logLevel: LogLevel.INFO,
  });

  // Route /harrybotter <subcommand>
  app.command("/harrybotter", async (args) => {
    const subcommand = (args.command.text || "").trim().toLowerCase();

    switch (subcommand) {
      case "create":
        return createHandler(config, registry)(args);
      case "destroy":
        return destroyHandler(config, registry)(args);
      case "status":
        return statusHandler(config, registry)(args);
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
          ].join("\n"),
        });
    }
  });

  await app.start();
  console.log("⚡ Harry Botter Orchestrator is running (Socket Mode)");

  // Graceful shutdown
  const shutdown = () => {
    console.log("Shutting down...");
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
