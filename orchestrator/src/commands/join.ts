import type {
  AllMiddlewareArgs,
  SlackCommandMiddlewareArgs,
} from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import { Registry } from "../registry";
import { podNameFromUserId } from "../k8s-client";
import type { Config } from "../config";

/**
 * /harrybotter join #channel-name
 *
 * Adds the user's Harry Botter instance to an existing channel.
 * The bot will respond when mentioned with @Harry Botter.
 */
export function joinHandler(config: Config, registry: Registry) {
  return async ({
    command,
    ack,
    respond,
  }: SlackCommandMiddlewareArgs & AllMiddlewareArgs) => {
    await ack();

    const userId = command.user_id;
    const rawText = (command.text || "").trim();

    // Extract channel ID from Slack's format: <#C123ABC|channel-name>
    const channelMatch = rawText.match(/<#(C[A-Z0-9]+)\|([^>]+)>/);
    if (!channelMatch) {
      await respond({
        response_type: "ephemeral",
        text: [
          `❌ Please specify a channel: \`/harrybotter join #channel-name\``,
          ``,
          `Example: \`/harrybotter join #general\``,
        ].join("\n"),
      });
      return;
    }

    const channelId = channelMatch[1];
    const channelName = channelMatch[2];

    // Look up user's bot
    const userBot = registry.getActive(userId);
    if (!userBot) {
      await respond({
        response_type: "ephemeral",
        text: `❌ You don't have an active Harry Botter instance. Use \`/harrybotter create\` first.`,
      });
      return;
    }

    const podName = userBot.pod_name;
    const svcHost = `${podName}-svc.${config.k8sNamespace}.svc.cluster.local`;

    try {
      // Invite master bot to the channel (so it can read messages)
      const masterClient = new WebClient(config.slackBotToken);
      try {
        await masterClient.conversations.join({ channel: channelId });
      } catch (joinErr: any) {
        // method_not_supported_for_channel_type = private channel, need invite
        // already_in_channel is fine
        if (
          joinErr?.data?.error !== "already_in_channel" &&
          joinErr?.data?.error !== "method_not_supported_for_channel_type"
        ) {
          console.warn(
            `[join] Master bot join failed: ${joinErr?.data?.error || (joinErr as Error).message}`
          );
        }
      }

      // Register the channel with the NanoClaw pod
      const sanitizedName = channelName.replace(/[^a-z0-9_-]/gi, "_");
      const regResp = await fetch(`http://${svcHost}:4000/register-group`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jid: `http:${channelId}`,
          name: channelName,
          folder: `slack_${sanitizedName}`,
          isMain: false,
          trigger: "@Harry Botter",
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!regResp.ok) {
        const errText = await regResp.text();
        throw new Error(`register-group responded ${regResp.status}: ${errText}`);
      }

      await respond({
        response_type: "ephemeral",
        text: `✅ Bot joined <#${channelId}>. Mention @Harry Botter to chat.`,
      });

      console.log(
        `[join] User ${userId} added bot to channel ${channelName} (${channelId})`
      );
    } catch (err) {
      console.error(`[join] Failed for ${userId}:`, err);
      await respond({
        response_type: "ephemeral",
        text: `❌ Failed to join channel: ${(err as Error).message}`,
      });
    }
  };
}
