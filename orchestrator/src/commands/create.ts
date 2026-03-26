import type {
  SlashCommand,
  AllMiddlewareArgs,
  SlackCommandMiddlewareArgs,
} from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import { v4 as uuidv4 } from "uuid";
import { Registry } from "../registry";
import { generateManifest } from "../manifest";
import type { Config } from "../config";
import * as crypto from "crypto";

function podName(userId: string): string {
  const hash = crypto
    .createHash("sha256")
    .update(userId)
    .digest("hex")
    .slice(0, 8);
  return `nc-${hash}`;
}

export function createHandler(config: Config, registry: Registry) {
  return async ({
    command,
    ack,
    respond,
  }: SlackCommandMiddlewareArgs & AllMiddlewareArgs) => {
    await ack();

    const userId = command.user_id;
    const username = command.user_name;

    // Check if user already has an active bot
    const existing = registry.getActive(userId);
    if (existing) {
      await respond({
        response_type: "ephemeral",
        text: [
          `⚡ You already have a Harry Botter instance!`,
          `• App ID: \`${existing.app_id}\``,
          `• Pod: \`${existing.pod_name}\``,
          `• Status: ${existing.status}`,
          ``,
          `Use \`/harrybotter destroy\` first if you want to recreate it.`,
        ].join("\n"),
      });
      return;
    }

    // Check for destroyed/stopped entry and clean up
    const stale = registry.get(userId);
    if (stale) {
      registry.delete(userId);
    }

    try {
      // Generate manifest for per-user Slack app
      const manifest = generateManifest({
        username,
        suffix: userId.slice(0, 8),
      });

      // Create Slack app via Manifest API
      const configClient = new WebClient(config.slackAppConfigurationToken);
      const createResult = await configClient.apiCall("apps.manifest.create", {
        manifest: JSON.stringify(manifest),
      });

      if (!createResult.ok) {
        throw new Error(
          `Manifest API failed: ${(createResult as any).error || "unknown"}`
        );
      }

      const appId = (createResult as any).app_id as string;
      const credentials = (createResult as any).credentials as {
        client_id: string;
        client_secret: string;
        verification_token: string;
        signing_secret: string;
      };

      // Store in registry
      const pod = podName(userId);
      const bot = registry.create({
        slack_user_id: userId,
        pod_name: pod,
        app_id: appId,
        bot_token: "", // Token comes after OAuth install — placeholder
        app_config_token: "", // Per-app config token if needed
        status: "active",
      });

      await respond({
        response_type: "ephemeral",
        text: [
          `🧙 Harry Botter instance created!`,
          ``,
          `• App ID: \`${appId}\``,
          `• Pod: \`${pod}\``,
          `• Status: \`active\``,
          ``,
          `📌 *Next steps:*`,
          `1. Install the app to your workspace (admin approval may be needed)`,
          `2. The bot will appear as *Harry Botter (${username})*`,
          `3. DM the bot to start chatting`,
          ``,
          `_Pod provisioning happens automatically via M3._`,
        ].join("\n"),
      });

      console.log(
        `[create] User ${userId} (${username}) → app=${appId} pod=${pod}`
      );
    } catch (err) {
      console.error(`[create] Failed for ${userId}:`, err);
      await respond({
        response_type: "ephemeral",
        text: `❌ Failed to create Harry Botter instance: ${(err as Error).message}`,
      });
    }
  };
}
