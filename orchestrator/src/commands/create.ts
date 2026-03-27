import type {
  SlashCommand,
  AllMiddlewareArgs,
  SlackCommandMiddlewareArgs,
} from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import { v4 as uuidv4 } from "uuid";
import { Registry } from "../registry";
import { generateManifest } from "../manifest";
import { K8sClient, podNameFromUserId } from "../k8s-client";
import { UserLock } from "../user-lock";
import type { Config } from "../config";
import { importPodData, getLatestBackup } from "../data-manager";
import * as crypto from "crypto";

function userHash(userId: string): string {
  return crypto.createHash("sha256").update(userId).digest("hex").slice(0, 8);
}

export function createHandler(
  config: Config,
  registry: Registry,
  k8sClient: K8sClient,
  userLock: UserLock
) {
  return async ({
    command,
    ack,
    respond,
    client,
  }: SlackCommandMiddlewareArgs & AllMiddlewareArgs) => {
    await ack();

    const userId = command.user_id;
    const slackUsername = command.user_name;
    // Parse custom bot name: /harrybotter create My Bot Name
    const cmdArgs = (command.text || "").replace(/^create\s*/i, "").trim();
    const customName = cmdArgs || null;
    const username = customName || slackUsername;
    const channelId = command.channel_id;

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

    // Acquire per-user lock
    const release = await userLock.acquire(userId);
    try {
      // Double-check after lock acquisition
      const doubleCheck = registry.getActive(userId);
      if (doubleCheck) {
        await respond({
          response_type: "ephemeral",
          text: `⚡ You already have a Harry Botter instance (race avoided).`,
        });
        return;
      }

      // Check for destroyed/stopped entry and clean up
      const stale = registry.get(userId);
      if (stale) {
        registry.delete(userId);
      }

      await respond({
        response_type: "ephemeral",
        text: `🧙 Creating your Harry Botter instance... hang tight.`,
      });

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

      // Update manifest with request_url now that we have the appId
      try {
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
        console.log(`[create] Updated manifest with request_url for app ${appId}`);
      } catch (err) {
        console.warn(`[create] Manifest update for request_url failed (non-fatal): ${(err as Error).message}`);
      }

      // Perform OAuth install to get bot_token
      let botToken = "";
      try {
        const oauthResult = await configClient.apiCall("tooling.tokens.rotate", {
          app_id: appId,
        }) as any;
        if (oauthResult.ok && oauthResult.token) {
          botToken = oauthResult.token;
          console.log(`[create] Obtained bot token via tooling.tokens.rotate for app ${appId}`);
        }
      } catch (err) {
        console.warn(`[create] Token rotation failed (non-fatal): ${(err as Error).message}`);
      }

      const pod = podNameFromUserId(userId);
      let secretName: string;
      try {
        secretName = await k8sClient.createSecret(userId, {
          "slack-bot-token": botToken || "placeholder",
        });
        console.log(`[create] Created K8s Secret ${secretName}`);
      } catch (err) {
        // Cleanup: delete the Slack app we just created
        try {
          await configClient.apiCall("apps.manifest.delete", {
            app_id: appId,
          });
        } catch {}
        throw new Error(
          `Failed to create K8s Secret: ${(err as Error).message}`
        );
      }

      // Create the K8s Pod
      try {
        await k8sClient.createPod(userId, botToken, username);
        console.log(`[create] Created K8s Pod ${pod}`);
      } catch (err) {
        // Cleanup: delete secret and Slack app
        try {
          await k8sClient.deleteSecret(secretName);
        } catch {}
        try {
          await configClient.apiCall("apps.manifest.delete", {
            app_id: appId,
          });
        } catch {}
        throw new Error(
          `Failed to create K8s Pod: ${(err as Error).message}`
        );
      }

      // Create the K8s Service
      let serviceName: string;
      try {
        serviceName = await k8sClient.createService(userId);
        console.log(`[create] Created K8s Service ${serviceName}`);
      } catch (err) {
        console.warn(
          `[create] Service creation failed (non-fatal): ${(err as Error).message}`
        );
      }

      // Wait for pod readiness
      await respond({
        response_type: "ephemeral",
        text: `⏳ Pod \`${pod}\` created. Waiting for readiness...`,
      });

      const ready = await k8sClient.waitForReady(pod, 60_000);

      if (!ready) {
        // Cleanup on readiness timeout
        console.error(`[create] Pod ${pod} failed readiness check`);
        try {
          await k8sClient.deletePod(pod);
        } catch {}
        try {
          await k8sClient.deleteSecret(`${pod}-secret`);
        } catch {}
        try {
          await k8sClient.deleteService(`${pod}-svc`);
        } catch {}
        try {
          await configClient.apiCall("apps.manifest.delete", {
            app_id: appId,
          });
        } catch {}
        throw new Error(
          `Pod ${pod} did not become ready within 60 seconds`
        );
      }

      // Restore data from backup if available
      const hash = userHash(userId);
      let restoreMessage = "";
      const latestBackup = getLatestBackup(config, hash);
      if (latestBackup) {
        try {
          await importPodData(config, pod, hash);
          const backupDate = new Date(latestBackup.timestamp).toLocaleString();
          restoreMessage = `\n📦 Previous data restored from backup (${backupDate})`;
          console.log(
            `[create] Restored backup for ${userId}: ${latestBackup.filename}`
          );
        } catch (err) {
          restoreMessage = `\n⚠️ Data restore failed: ${(err as Error).message}`;
          console.warn(`[create] Data restore failed for ${userId}:`, err);
        }
      }

      // Auto-create private Slack channel for the user
      let autoChannelId = "";
      let channelMessage = "";
      try {
        const channelName = `hb-${username}`.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 80);
        const masterClient = new WebClient(config.slackBotToken);

        const createChannelResult = await masterClient.conversations.create({
          name: channelName,
          is_private: true,
        });

        if (createChannelResult.ok && createChannelResult.channel?.id) {
          autoChannelId = createChannelResult.channel.id;

          // Invite the user to the channel
          try {
            await masterClient.conversations.invite({
              channel: autoChannelId,
              users: userId,
            });
          } catch (inviteErr: any) {
            // already_in_channel is fine
            if (inviteErr?.data?.error !== "already_in_channel") {
              console.warn(`[create] Failed to invite user to channel: ${(inviteErr as Error).message}`);
            }
          }

          // Register the channel with the NanoClaw pod
          // Use pod IP directly (orchestrator runs outside K8s, can't resolve svc.cluster.local)
          try {
            const { getPodUrl } = await import("../pod-proxy");
            const podBaseUrl = await getPodUrl(pod, config.k8sNamespace, 4000);
            const regResp = await fetch(`${podBaseUrl}/register-group`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                jid: `http:${autoChannelId}`,
                name: channelName,
                folder: "slack_main",
                isMain: true,
              }),
              signal: AbortSignal.timeout(10_000),
            });
            if (!regResp.ok) {
              console.warn(`[create] register-group responded ${regResp.status}`);
            }
          } catch (regErr) {
            console.warn(`[create] register-group failed (non-fatal): ${(regErr as Error).message}`);
          }

          channelMessage = `\n💬 Your channel: <#${autoChannelId}>`;
          console.log(`[create] Created channel ${channelName} (${autoChannelId}) for ${userId}`);
        }
      } catch (chanErr: any) {
        // name_taken means channel already exists — try to find it
        if (chanErr?.data?.error === "name_taken") {
          console.warn(`[create] Channel hb-${username} already exists, skipping auto-create`);
        } else {
          console.warn(`[create] Channel creation failed (non-fatal): ${(chanErr as Error).message}`);
        }
      }

      // Store in registry
      registry.create({
        slack_user_id: userId,
        pod_name: pod,
        app_id: appId,
        bot_token: botToken,
        app_config_token: "",
        signing_secret: credentials.signing_secret,
        client_id: credentials.client_id,
        client_secret: credentials.client_secret,
        status: "active",
        retention_mode: config.defaultRetentionMode,
        channel_id: autoChannelId,
      });

      await respond({
        response_type: "ephemeral",
        text: [
          `🧙 Harry Botter instance created!`,
          ``,
          `• App ID: \`${appId}\``,
          `• Pod: \`${pod}\` — ✅ Ready`,
          `• Status: \`active\``,
          restoreMessage,
          channelMessage,
          ``,
          `📌 *Next steps:*`,
          `1. <https://api.slack.com/apps/${appId}/install-on-team|Install the app to your workspace>`,
          `2. Go to <https://api.slack.com/apps/${appId}/oauth|OAuth & Permissions> → copy the *Bot User OAuth Token*`,
          `3. Run \`/harrybotter settoken xoxb-your-token-here\``,
          `4. DM *Harry Botter (${username})* or chat in ${autoChannelId ? `<#${autoChannelId}>` : "your channel"} to start`,
        ].join("\n"),
      });

      console.log(
        `[create] User ${userId} (${username}) → app=${appId} pod=${pod} ✓`
      );
    } catch (err) {
      const slackErr = err as any;
      if (slackErr?.data?.errors) {
        console.error(`[create] Manifest errors for ${userId}:`, JSON.stringify(slackErr.data.errors, null, 2));
      }
      console.error(`[create] Failed for ${userId}:`, err);
      await respond({
        response_type: "ephemeral",
        text: `❌ Failed to create Harry Botter instance: ${(err as Error).message}`,
      });
    } finally {
      release();
    }
  };
}
