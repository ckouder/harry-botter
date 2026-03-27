import type {
  AllMiddlewareArgs,
  SlackCommandMiddlewareArgs,
} from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import type { Registry } from "../registry";
import type { Config } from "../config";
import type { K8sClient } from "../k8s-client";
import { generateManifest } from "../manifest";

export function settokenHandler(
  config: Config,
  registry: Registry,
  k8sClient: K8sClient
) {
  return async ({
    command,
    ack,
    respond,
  }: SlackCommandMiddlewareArgs & AllMiddlewareArgs) => {
    await ack();

    const userId = command.user_id;
    const tokenText = (command.text || "")
      .replace(/^settoken\s*/i, "")
      .trim();

    if (!tokenText) {
      await respond({
        response_type: "ephemeral",
        text: [
          "Usage: `/harrybotter settoken xoxb-your-bot-token`",
          "",
          "To get your bot token:",
          "1. Go to your app's page on api.slack.com/apps",
          "2. Navigate to *OAuth & Permissions*",
          "3. Copy the *Bot User OAuth Token* (starts with `xoxb-`)",
        ].join("\n"),
      });
      return;
    }

    if (!tokenText.startsWith("xoxb-")) {
      await respond({
        response_type: "ephemeral",
        text: "❌ Invalid token format. Bot tokens start with `xoxb-`.",
      });
      return;
    }

    const userBot = registry.getActive(userId);
    if (!userBot) {
      await respond({
        response_type: "ephemeral",
        text: "❌ No active Harry Botter instance found. Run `/harrybotter create` first.",
      });
      return;
    }

    // Validate the token by calling auth.test
    try {
      const client = new WebClient(tokenText);
      const authResult = await client.auth.test();
      if (!authResult.ok) {
        await respond({
          response_type: "ephemeral",
          text: "❌ Token validation failed. Make sure you copied the correct Bot User OAuth Token.",
        });
        return;
      }
      console.log(
        `[settoken] Token validated for ${userId}: bot_user_id=${authResult.user_id}, team=${authResult.team}`
      );
    } catch (err) {
      await respond({
        response_type: "ephemeral",
        text: `❌ Token validation failed: ${(err as Error).message}`,
      });
      return;
    }

    // Store bot token in registry
    registry.updateToken(userId, tokenText, "settoken command");

    // Update K8s secret
    try {
      const podName = userBot.pod_name;
      await k8sClient.createSecret(userId, {
        "slack-bot-token": tokenText,
      });
      console.log(`[settoken] Updated K8s secret for ${userId}`);
    } catch (err) {
      console.warn(
        `[settoken] K8s secret update failed: ${(err as Error).message}`
      );
    }

    // Update manifest with request_url now that the app is installed
    try {
      const configClient = new WebClient(config.slackAppConfigurationToken);
      const updatedManifest = generateManifest({
        username: command.user_name,
        suffix: userId.slice(0, 8),
        appId: userBot.app_id,
        eventGatewayUrl: config.eventGatewayUrl,
      });
      await configClient.apiCall("apps.manifest.update", {
        app_id: userBot.app_id,
        manifest: JSON.stringify(updatedManifest),
      });
      console.log(
        `[settoken] Updated manifest with request_url for app ${userBot.app_id}`
      );
    } catch (err) {
      console.warn(
        `[settoken] Manifest update failed: ${(err as Error).message}`
      );
    }

    await respond({
      response_type: "ephemeral",
      text: [
        "✅ Bot token set and validated!",
        "",
        `• App: \`${userBot.app_id}\``,
        `• Pod: \`${userBot.pod_name}\``,
        "",
        "Your bot is now connected. Try:",
        `• DM *Harry Botter (${command.user_name})* directly`,
        userBot.channel_id
          ? `• Or chat in <#${userBot.channel_id}>`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    });
  };
}
