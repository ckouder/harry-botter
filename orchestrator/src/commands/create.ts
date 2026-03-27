import type {
  AllMiddlewareArgs,
  SlackCommandMiddlewareArgs,
} from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import { Registry } from "../registry";
import { generateManifest } from "../manifest";
import { UserLock } from "../user-lock";
import type { Config } from "../config";

export function createHandler(
  config: Config,
  registry: Registry,
  _k8sClient: unknown,
  userLock: UserLock
) {
  return async ({
    command,
    ack,
    respond,
  }: SlackCommandMiddlewareArgs & AllMiddlewareArgs) => {
    await ack();

    const userId = command.user_id;
    const slackUsername = command.user_name;
    const cmdArgs = (command.text || "").replace(/^create\s*/i, "").trim();
    const customName = cmdArgs || null;
    const username = customName || slackUsername;

    // Check if user already has a bot (any status)
    const existing = registry.get(userId);
    if (existing && existing.status !== "destroyed") {
      const statusMsg =
        existing.status === "pending_install"
          ? [
              `⏳ You have a pending app install!`,
              ``,
              `• App ID: \`${existing.app_id}\``,
              ``,
              `📌 *Complete setup:*`,
              `1. <https://api.slack.com/apps/${existing.app_id}/install-on-team|Install the app to your workspace>`,
              `2. Go to <https://api.slack.com/apps/${existing.app_id}/oauth|OAuth & Permissions> → copy the *Bot User OAuth Token*`,
              `3. Run \`/harrybotter settoken xoxb-your-token-here\``,
            ].join("\n")
          : [
              `⚡ You already have a Harry Botter instance!`,
              `• App ID: \`${existing.app_id}\``,
              `• Pod: \`${existing.pod_name}\``,
              `• Status: ${existing.status}`,
              ``,
              `Use \`/harrybotter destroy\` first to recreate.`,
            ].join("\n");

      await respond({ response_type: "ephemeral", text: statusMsg });
      return;
    }

    const release = await userLock.acquire(userId);
    try {
      // Clean up any destroyed entry
      const stale = registry.get(userId);
      if (stale) registry.delete(userId);

      await respond({
        response_type: "ephemeral",
        text: `🧙 Creating your Slack app "${username}"...`,
      });

      // Phase 1: Create Slack app only
      const manifest = generateManifest({
        username,
        suffix: userId.slice(0, 8),
      });

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

      // Store in registry with pending_install status — no pod yet
      registry.create({
        slack_user_id: userId,
        pod_name: "", // filled in by settoken
        app_id: appId,
        bot_token: "",
        app_config_token: "",
        signing_secret: credentials.signing_secret,
        client_id: credentials.client_id,
        client_secret: credentials.client_secret,
        status: "pending_install",
        retention_mode: config.defaultRetentionMode,
        channel_id: "",
        bot_name: username,
      });

      console.log(
        `[create] Phase 1 complete: app=${appId} for ${userId} (${username})`
      );

      await respond({
        response_type: "ephemeral",
        text: [
          `✅ Slack app "${username}" created!`,
          ``,
          `• App ID: \`${appId}\``,
          ``,
          `📌 *Complete setup (3 steps):*`,
          `1. <https://api.slack.com/apps/${appId}/install-on-team|Install the app to your workspace>`,
          `2. Go to <https://api.slack.com/apps/${appId}/oauth|OAuth & Permissions> → copy the *Bot User OAuth Token*`,
          `3. Run \`/harrybotter settoken xoxb-your-token-here\``,
          ``,
          `Your bot will be provisioned after you provide the token.`,
        ].join("\n"),
      });
    } catch (err) {
      const slackErr = err as any;
      if (slackErr?.data?.errors) {
        console.error(
          `[create] Manifest errors:`,
          JSON.stringify(slackErr.data.errors, null, 2)
        );
      }
      console.error(`[create] Failed for ${userId}:`, err);
      await respond({
        response_type: "ephemeral",
        text: `❌ Failed to create app: ${(err as Error).message}`,
      });
    } finally {
      release();
    }
  };
}
