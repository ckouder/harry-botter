/**
 * HTTP Event Gateway — receives Slack events via Request URL mode
 * and routes them to per-user NanoClaw pods.
 */

import express, { type Request, type Response } from "express";
import * as crypto from "crypto";
import type { Config } from "./config";
import type { Registry } from "./registry";

const NANOCLAW_MESSAGE_PORT = 4000;

interface SlackEvent {
  type: string;
  challenge?: string;
  token?: string;
  event?: {
    type: string;
    text?: string;
    user?: string;
    channel?: string;
    ts?: string;
    bot_id?: string;
    subtype?: string;
    [key: string]: unknown;
  };
  event_id?: string;
  event_time?: number;
  api_app_id?: string;
  [key: string]: unknown;
}

/**
 * Verify Slack request signature using the per-app signing secret.
 */
function verifySlackSignature(
  signingSecret: string,
  signature: string | undefined,
  timestamp: string | undefined,
  rawBody: string
): boolean {
  if (!signature || !timestamp) return false;

  // Reject requests older than 5 minutes
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp, 10)) > 300) return false;

  const baseString = `v0:${timestamp}:${rawBody}`;
  const hmac = crypto
    .createHmac("sha256", signingSecret)
    .update(baseString)
    .digest("hex");
  const expected = `v0=${hmac}`;

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected)
  );
}

/**
 * Forward a message to a NanoClaw pod and return the response.
 */
async function forwardToPod(
  podName: string,
  k8sNamespace: string,
  event: NonNullable<SlackEvent["event"]>
): Promise<string | null> {
  // Use pod-proxy for reliable connectivity (handles port-forwarding when outside K8s)
  const { getPodUrl } = await import("./pod-proxy.js");
  let baseUrl: string;
  try {
    baseUrl = await getPodUrl(podName, k8sNamespace, NANOCLAW_MESSAGE_PORT);
  } catch {
    // Fallback to service DNS (works inside K8s)
    baseUrl = `http://${podName}-svc.${k8sNamespace}.svc.cluster.local:${NANOCLAW_MESSAGE_PORT}`;
  }
  const url = `${baseUrl}/message`;

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: event.text || "",
        user: event.user,
        channel: event.channel,
        ts: event.ts,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      console.error(
        `[event-gateway] Pod ${podName} responded with ${resp.status}: ${await resp.text()}`
      );
      return null;
    }

    const data = (await resp.json()) as { reply?: string; text?: string };
    return data.reply || data.text || null;
  } catch (err) {
    console.error(
      `[event-gateway] Failed to forward to pod ${podName}:`,
      (err as Error).message
    );
    return null;
  }
}

/**
 * Post a reply to Slack using the per-user bot token.
 */
async function postSlackReply(
  botToken: string,
  channel: string,
  text: string
): Promise<void> {
  const resp = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${botToken}`,
    },
    body: JSON.stringify({ channel, text }),
  });

  const data = (await resp.json()) as { ok: boolean; error?: string };
  if (!data.ok) {
    console.error(`[event-gateway] chat.postMessage failed: ${data.error}`);
  }
}

export interface EventGatewayOptions {
  config: Config;
  registry: Registry;
}

/**
 * Start the HTTP event gateway.
 * Returns the Express app and a close function.
 */
export function startEventGateway(opts: EventGatewayOptions): {
  app: express.Express;
  close: () => void;
} {
  const { config, registry } = opts;
  const app = express();

  // We need the raw body for signature verification
  app.use(
    express.json({
      verify: (req: any, _res, buf) => {
        req.rawBody = buf.toString("utf-8");
      },
    })
  );

  // Health check
  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  // Slack events endpoint
  app.post("/slack/events/:appId", async (req: Request, res: Response) => {
    const appId = req.params.appId as string;
    const body = req.body as SlackEvent;
    const rawBody = (req as any).rawBody as string;

    console.log(
      `[event-gateway] Received event type=${body.type} appId=${appId} event_id=${body.event_id || "n/a"}`
    );

    // Handle Slack URL verification challenge
    if (body.type === "url_verification") {
      console.log(`[event-gateway] URL verification for appId=${appId}`);
      res.json({ challenge: body.challenge });
      return;
    }

    // Handle retry — Slack sends X-Slack-Retry-Num on retries
    const retryNum = req.headers["x-slack-retry-num"];
    const retryReason = req.headers["x-slack-retry-reason"];
    if (retryNum) {
      console.log(
        `[event-gateway] Retry #${retryNum} reason=${retryReason} for appId=${appId} event_id=${body.event_id}`
      );
      // Acknowledge retries immediately to prevent Slack from disabling the URL
      res.status(200).json({ ok: true });
      return;
    }

    // Look up the app in registry
    const userBot = registry.getByAppId(appId);
    if (!userBot) {
      console.warn(`[event-gateway] Unknown appId=${appId} — no registry entry`);
      res.status(404).json({ error: "unknown_app" });
      return;
    }

    // Verify signing secret
    const slackSig = Array.isArray(req.headers["x-slack-signature"])
      ? req.headers["x-slack-signature"][0]
      : req.headers["x-slack-signature"];
    const slackTs = Array.isArray(req.headers["x-slack-request-timestamp"])
      ? req.headers["x-slack-request-timestamp"][0]
      : req.headers["x-slack-request-timestamp"];
    if (!verifySlackSignature(userBot.signing_secret, slackSig, slackTs, rawBody)) {
      console.warn(
        `[event-gateway] Signature verification failed for appId=${appId}`
      );
      res.status(401).json({ error: "invalid_signature" });
      return;
    }

    // Acknowledge immediately (Slack expects 200 within 3 seconds)
    res.status(200).json({ ok: true });

    // Process event_callback asynchronously
    if (body.type === "event_callback" && body.event) {
      const event = body.event;

      // Only handle message events, skip bot messages
      if (event.type !== "message" || event.bot_id || event.subtype) {
        console.log(
          `[event-gateway] Skipping event: type=${event.type} bot_id=${event.bot_id} subtype=${event.subtype}`
        );
        return;
      }

      // Determine if this is a DM or a channel/group message
      const channelType = (event as any).channel_type as string | undefined;
      const isDm = channelType === "im";

      // For channel/group messages, only forward if the bot is mentioned
      if (!isDm && event.text) {
        // Bot user ID is embedded in mentions as <@U...>
        // We need to check if the per-user bot is mentioned
        // The bot_token can be used to look up the bot user ID, but for
        // efficiency we check for any bot mention pattern and let the pod decide.
        // Alternatively, check for "Harry Botter" text mention or <@BOT_USER_ID>
        const text = event.text.toLowerCase();
        const hasMention = text.includes("harry botter") || text.includes("@harry botter");
        const hasAtMention = /<@[A-Z0-9]+>/.test(event.text || "");

        if (!hasMention && !hasAtMention) {
          console.log(
            `[event-gateway] Skipping channel message without mention in channel=${event.channel}`
          );
          return;
        }
      }

      console.log(
        `[event-gateway] Processing message from user=${event.user} channel=${event.channel} type=${channelType || "unknown"} pod=${userBot.pod_name}`
      );

      // Forward to pod
      const reply = await forwardToPod(
        userBot.pod_name,
        config.k8sNamespace,
        event
      );

      if (reply && event.channel && userBot.bot_token) {
        await postSlackReply(userBot.bot_token, event.channel, reply);
        console.log(
          `[event-gateway] Posted reply to channel=${event.channel} for appId=${appId}`
        );
      }
    }
  });

  const server = app.listen(config.eventGatewayPort, () => {
    console.log(
      `⚡ Event Gateway listening on port ${config.eventGatewayPort}`
    );
  });

  return {
    app,
    close: () => {
      server.close();
    },
  };
}
