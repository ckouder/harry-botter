import type {
  AllMiddlewareArgs,
  SlackCommandMiddlewareArgs,
} from "@slack/bolt";
import { Registry } from "../registry";
import type { Config, RetentionMode } from "../config";

const VALID_MODES: RetentionMode[] = ["retain", "delete"];

export function configRetentionHandler(config: Config, registry: Registry) {
  return async ({
    command,
    ack,
    respond,
  }: SlackCommandMiddlewareArgs & AllMiddlewareArgs) => {
    await ack();

    const userId = command.user_id;

    // Parse: "config retention retain" or "config retention delete"
    const parts = (command.text || "").trim().split(/\s+/);
    // parts[0] = "config", parts[1] = "retention", parts[2] = mode
    const mode = parts[2] as RetentionMode | undefined;

    if (!mode || !VALID_MODES.includes(mode)) {
      const current =
        registry.getRetentionMode(userId) || config.defaultRetentionMode;
      await respond({
        response_type: "ephemeral",
        text: [
          `⚙️ *Retention Configuration*`,
          ``,
          `Current mode: \`${current}\``,
          ``,
          `Usage: \`/harrybotter config retention retain|delete\``,
          `• \`retain\` — Export data before destroying your pod`,
          `• \`delete\` — Permanently delete data on destroy`,
        ].join("\n"),
      });
      return;
    }

    const bot = registry.get(userId);
    if (!bot) {
      await respond({
        response_type: "ephemeral",
        text: `🤷 You don't have a Harry Botter instance yet. Use \`/harrybotter create\` first.`,
      });
      return;
    }

    registry.updateRetentionMode(userId, mode);

    const action = mode === "retain" ? "retained" : "deleted";
    await respond({
      response_type: "ephemeral",
      text: `✅ Retention mode set to \`${mode}\`. On destroy, your data will be ${action}.`,
    });

    console.log(`[config-retention] User ${userId} → retention_mode=${mode}`);
  };
}
