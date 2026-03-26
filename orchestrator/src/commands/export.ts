import type {
  AllMiddlewareArgs,
  SlackCommandMiddlewareArgs,
} from "@slack/bolt";
import { Registry } from "../registry";
import type { Config } from "../config";
import { exportPodData, getBackupInfo } from "../data-manager";
import * as crypto from "crypto";

function userHash(userId: string): string {
  return crypto.createHash("sha256").update(userId).digest("hex").slice(0, 8);
}

export function exportHandler(config: Config, registry: Registry) {
  return async ({
    command,
    ack,
    respond,
  }: SlackCommandMiddlewareArgs & AllMiddlewareArgs) => {
    await ack();

    const userId = command.user_id;
    const bot = registry.getActive(userId);

    if (!bot) {
      await respond({
        response_type: "ephemeral",
        text: `🤷 You don't have an active Harry Botter instance. Nothing to export.`,
      });
      return;
    }

    try {
      await respond({
        response_type: "ephemeral",
        text: `⏳ Exporting data from pod \`${bot.pod_name}\`... This may take a moment.`,
      });

      const hash = userHash(userId);
      const backup = await exportPodData(config, bot.pod_name, hash);
      const allBackups = getBackupInfo(config, hash);
      const totalSizeMb = allBackups.reduce((s, b) => s + b.sizeMb, 0);

      await respond({
        response_type: "ephemeral",
        text: [
          `📦 *Data Export Complete*`,
          ``,
          `• File: \`${backup.filename}\``,
          `• Size: ${backup.sizeMb} MB`,
          `• Timestamp: ${backup.timestamp}`,
          `• Total backups: ${allBackups.length} (${totalSizeMb.toFixed(1)} MB)`,
          `• Limit: ${config.maxBackupSizeMb} MB`,
        ].join("\n"),
      });

      console.log(
        `[export] User ${userId} → ${backup.filename} (${backup.sizeMb}MB)`
      );
    } catch (err) {
      console.error(`[export] Failed for ${userId}:`, err);
      await respond({
        response_type: "ephemeral",
        text: `❌ Export failed: ${(err as Error).message}`,
      });
    }
  };
}
