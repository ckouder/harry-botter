import type {
  AllMiddlewareArgs,
  SlackCommandMiddlewareArgs,
} from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import { Registry } from "../registry";
import { K8sClient } from "../k8s-client";
import { UserLock } from "../user-lock";
import type { Config } from "../config";
import { exportPodData, cleanupBackups } from "../data-manager";
import * as crypto from "crypto";

function userHash(userId: string): string {
  return crypto.createHash("sha256").update(userId).digest("hex").slice(0, 8);
}

export function destroyHandler(
  config: Config,
  registry: Registry,
  k8sClient: K8sClient,
  userLock: UserLock
) {
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

    const release = await userLock.acquire(userId);
    try {
      await respond({
        response_type: "ephemeral",
        text: `💀 Destroying your Harry Botter instance...`,
      });

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

      // Handle data retention
      const retentionMode =
        registry.getRetentionMode(userId) || config.defaultRetentionMode;
      const hash = userHash(userId);
      let dataMessage = "";

      if (retentionMode === "retain" && bot.pod_name) {
        try {
          const backup = await exportPodData(config, bot.pod_name, hash);
          dataMessage = `📦 Data exported to backup (${backup.sizeMb} MB)`;
          console.log(
            `[destroy] Exported data for ${userId}: ${backup.filename}`
          );
        } catch (err) {
          dataMessage = `⚠️ Data export failed: ${(err as Error).message}`;
          console.warn(`[destroy] Data export failed for ${userId}:`, err);
        }
      } else if (retentionMode === "delete") {
        cleanupBackups(config, hash);
        dataMessage = `🗑️ Data permanently deleted`;
        console.log(`[destroy] Cleaned up backups for ${userId}`);
      }

      // Delete K8s Pod (30s graceful shutdown)
      if (bot.pod_name) {
        try {
          await k8sClient.deletePod(bot.pod_name, 30);
          console.log(`[destroy] Deleted K8s Pod ${bot.pod_name}`);
        } catch (err) {
          console.warn(
            `[destroy] Could not delete Pod ${bot.pod_name}:`,
            (err as Error).message
          );
        }
      }

      // Delete K8s Secret
      const secretName = `${bot.pod_name}-secret`;
      try {
        await k8sClient.deleteSecret(secretName);
        console.log(`[destroy] Deleted K8s Secret ${secretName}`);
      } catch (err) {
        console.warn(
          `[destroy] Could not delete Secret ${secretName}:`,
          (err as Error).message
        );
      }

      // Delete K8s Service
      const serviceName = `${bot.pod_name}-svc`;
      try {
        await k8sClient.deleteService(serviceName);
        console.log(`[destroy] Deleted K8s Service ${serviceName}`);
      } catch (err) {
        console.warn(
          `[destroy] Could not delete Service ${serviceName}:`,
          (err as Error).message
        );
      }

      // Update registry
      registry.updateStatus(userId, "destroyed");

      await respond({
        response_type: "ephemeral",
        text: [
          `💀 Harry Botter instance destroyed.`,
          ``,
          `• App ID: \`${bot.app_id}\` — deleted`,
          `• Pod: \`${bot.pod_name}\` — deleted`,
          `• Secret: \`${secretName}\` — deleted`,
          `• Service: \`${serviceName}\` — deleted`,
          dataMessage ? `• ${dataMessage}` : "",
          ``,
          `Use \`/harrybotter create\` to spin up a new one.`,
        ]
          .filter(Boolean)
          .join("\n"),
      });

      console.log(
        `[destroy] User ${userId} → app=${bot.app_id} pod=${bot.pod_name} destroyed ✓`
      );
    } catch (err) {
      console.error(`[destroy] Failed for ${userId}:`, err);
      await respond({
        response_type: "ephemeral",
        text: `❌ Failed to destroy instance: ${(err as Error).message}`,
      });
    } finally {
      release();
    }
  };
}
