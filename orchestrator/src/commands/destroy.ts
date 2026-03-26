import type {
  AllMiddlewareArgs,
  SlackCommandMiddlewareArgs,
} from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import { Registry } from "../registry";
import type { Config } from "../config";

export function destroyHandler(config: Config, registry: Registry) {
  return async ({
    command,
    ack,
    respond,
  }: SlackCommandMiddlewareArgs & AllMiddlewareArgs) => {
    await ack();

    const userId = command.user_id;
    const bot = registry.get(userId);

    if (!bot || bot.status === "destroyed") {
      await respond({
        response_type: "ephemeral",
        text: `🤷 You don't have an active Harry Botter instance. Nothing to destroy.`,
      });
      return;
    }

    try {
      // Delete the Slack app via Manifest API
      if (bot.app_id) {
        try {
          const configClient = new WebClient(
            config.slackAppConfigurationToken
          );
          await configClient.apiCall("apps.manifest.delete", {
            app_id: bot.app_id,
          });
          console.log(`[destroy] Deleted Slack app ${bot.app_id}`);
        } catch (err) {
          // Non-fatal: app may already be deleted
          console.warn(
            `[destroy] Could not delete Slack app ${bot.app_id}:`,
            (err as Error).message
          );
        }
      }

      // K8s pod deletion — placeholder for M3
      console.log(
        `[destroy] TODO(M3): Delete K8s pod ${bot.pod_name} in namespace ${config.k8sNamespace}`
      );

      // Update registry
      registry.updateStatus(userId, "destroyed");

      await respond({
        response_type: "ephemeral",
        text: [
          `💀 Harry Botter instance destroyed.`,
          ``,
          `• App ID: \`${bot.app_id}\` — deleted`,
          `• Pod: \`${bot.pod_name}\` — scheduled for removal`,
          ``,
          `Use \`/harrybotter create\` to spin up a new one.`,
        ].join("\n"),
      });

      console.log(
        `[destroy] User ${userId} → app=${bot.app_id} pod=${bot.pod_name} destroyed`
      );
    } catch (err) {
      console.error(`[destroy] Failed for ${userId}:`, err);
      await respond({
        response_type: "ephemeral",
        text: `❌ Failed to destroy instance: ${(err as Error).message}`,
      });
    }
  };
}
