import type {
  AllMiddlewareArgs,
  SlackCommandMiddlewareArgs,
} from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import type { Registry } from "../registry";
import type { Config } from "../config";
import { K8sClient, podNameFromUserId } from "../k8s-client";
import { generateManifest } from "../manifest";
import { importPodData, getLatestBackup } from "../data-manager";
import * as crypto from "crypto";

function userHash(userId: string): string {
  return crypto.createHash("sha256").update(userId).digest("hex").slice(0, 8);
}

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
    const username = command.user_name;
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

    const userBot = registry.get(userId);
    if (!userBot) {
      await respond({
        response_type: "ephemeral",
        text: "❌ No Harry Botter app found. Run `/harrybotter create` first.",
      });
      return;
    }

    // Validate the token
    let botUserId = "";
    try {
      const client = new WebClient(tokenText);
      const authResult = await client.auth.test();
      if (!authResult.ok) {
        throw new Error("auth.test failed");
      }
      botUserId = authResult.user_id as string;
      console.log(
        `[settoken] Token validated: bot_user_id=${botUserId}, team=${authResult.team}`
      );
    } catch (err) {
      await respond({
        response_type: "ephemeral",
        text: `❌ Token validation failed: ${(err as Error).message}`,
      });
      return;
    }

    await respond({
      response_type: "ephemeral",
      text: "⏳ Token validated! Provisioning your bot...",
    });

    try {
      // Store bot token
      registry.updateToken(userId, tokenText, "settoken command");

      const appId = userBot.app_id;
      const pod = podNameFromUserId(userId);

      // Update manifest with request_url
      try {
        const configClient = new WebClient(config.slackAppConfigurationToken);
        const updatedManifest = generateManifest({
          username,
          suffix: userId.slice(0, 8),
          appId,
          eventGatewayUrl: config.eventGatewayUrl,
        });
        await configClient.apiCall("apps.manifest.update", {
          app_id: appId,
          manifest: JSON.stringify(updatedManifest),
        });
        console.log(`[settoken] Updated manifest with request_url for ${appId}`);
      } catch (err) {
        console.warn(`[settoken] Manifest update failed: ${(err as Error).message}`);
      }

      // Create K8s Secret
      await k8sClient.createSecret(userId, {
        "slack-bot-token": tokenText,
      });
      console.log(`[settoken] Created/updated K8s secret for ${userId}`);

      // Create K8s Pod (if not already running)
      let podCreated = false;
      try {
        const existingPod = await k8sClient.getPodStatus(pod);
        if (!existingPod) {
          await k8sClient.createPod(userId, tokenText, username);
          podCreated = true;
          console.log(`[settoken] Created pod ${pod}`);
        }
      } catch {
        await k8sClient.createPod(userId, tokenText, username);
        podCreated = true;
        console.log(`[settoken] Created pod ${pod}`);
      }

      // Create K8s Service
      try {
        await k8sClient.createService(userId);
      } catch (err: any) {
        if (!String(err?.message || "").includes("AlreadyExists") && !String(err?.message || "").includes("409")) {
          console.warn(`[settoken] Service creation: ${(err as Error).message}`);
        }
      }

      // Wait for pod readiness
      if (podCreated) {
        await respond({
          response_type: "ephemeral",
          text: `⏳ Pod \`${pod}\` created. Waiting for readiness...`,
        });
        const ready = await k8sClient.waitForReady(pod, 90_000);
        if (!ready) {
          console.warn(`[settoken] Pod ${pod} not ready within 90s`);
        }
      }

      // Restore data from backup if available
      const hash = userHash(userId);
      let restoreMessage = "";
      const latestBackup = getLatestBackup(config, hash);
      if (latestBackup) {
        try {
          await importPodData(config, pod, hash);
          restoreMessage = `\n📦 Previous data restored`;
        } catch (err) {
          restoreMessage = `\n⚠️ Data restore failed: ${(err as Error).message}`;
        }
      }

      // Auto-create private channel
      let channelId = "";
      let channelMessage = "";
      try {
        const channelName = `hb-${username}`.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 80);
        const masterClient = new WebClient(config.slackBotToken);

        const createChannelResult = await masterClient.conversations.create({
          name: channelName,
          is_private: true,
        });

        if (createChannelResult.ok && createChannelResult.channel?.id) {
          channelId = createChannelResult.channel.id;

          // Invite user to the channel
          try {
            await masterClient.conversations.invite({
              channel: channelId,
              users: userId,
            });
          } catch {}

          // Invite the per-user bot to the channel using its own token
          try {
            const userBotClient = new WebClient(tokenText);
            // Bot needs to join the channel — use conversations.join if public,
            // or the master bot invites it if private
            try {
              await userBotClient.conversations.join({ channel: channelId });
            } catch {
              // Private channel — master bot invites the per-user bot
              await masterClient.conversations.invite({
                channel: channelId,
                users: botUserId,
              });
            }
            console.log(`[settoken] Invited per-user bot ${botUserId} to channel ${channelId}`);
          } catch (botInviteErr) {
            console.warn(`[settoken] Bot invite to channel: ${(botInviteErr as Error).message}`);
          }

          // Register with NanoClaw pod
          try {
            const { getPodUrl } = await import("../pod-proxy");
            const podBaseUrl = await getPodUrl(pod, config.k8sNamespace, 4000);
            await fetch(`${podBaseUrl}/register-group`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                jid: `http:${channelId}`,
                name: channelName,
                folder: "slack_main",
                isMain: true,
              }),
              signal: AbortSignal.timeout(10_000),
            });
          } catch (regErr) {
            console.warn(`[settoken] register-group: ${(regErr as Error).message}`);
          }

          channelMessage = `\n💬 Your channel: <#${channelId}>`;
        }
      } catch (chanErr: any) {
        if (chanErr?.data?.error !== "name_taken") {
          console.warn(`[settoken] Channel creation: ${(chanErr as Error).message}`);
        }
      }

      // Update registry
      registry.updateStatus(userId, "active");
      if (channelId) {
        registry.updateChannelId(userId, channelId);
      }
      // Update pod_name in registry
      const db = (registry as any).db;
      if (db) {
        db.prepare("UPDATE user_bots SET pod_name = ? WHERE slack_user_id = ?").run(pod, userId);
      }

      console.log(`[settoken] Phase 2 complete: ${userId} → pod=${pod}, app=${appId}`);

      await respond({
        response_type: "ephemeral",
        text: [
          `🎉 Your bot is live!`,
          ``,
          `• App: \`${appId}\``,
          `• Pod: \`${pod}\` — ✅ Running`,
          restoreMessage,
          channelMessage,
          ``,
          `DM your bot or chat in ${channelId ? `<#${channelId}>` : "a channel"} to start!`,
        ]
          .filter(Boolean)
          .join("\n"),
      });
    } catch (err) {
      console.error(`[settoken] Failed for ${userId}:`, err);
      await respond({
        response_type: "ephemeral",
        text: `❌ Provisioning failed: ${(err as Error).message}`,
      });
    }
  };
}
