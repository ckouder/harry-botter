import type {
  AllMiddlewareArgs,
  SlackCommandMiddlewareArgs,
} from "@slack/bolt";
import * as crypto from "crypto";
import { Registry } from "../registry";
import type { Config } from "../config";
import type { K8sClient } from "../k8s-client";
import {
  validateAnthropicKey,
  createAnthropicSecret,
  getUserAnthropicSecretName,
} from "../secrets-manager";

function uHash(userId: string): string {
  return crypto.createHash("sha256").update(userId).digest("hex").slice(0, 8);
}

export function setkeyHandler(
  config: Config,
  registry: Registry,
  k8s: K8sClient
) {
  return async ({
    command,
    ack,
    respond,
  }: SlackCommandMiddlewareArgs & AllMiddlewareArgs) => {
    await ack();

    const userId = command.user_id;
    const parts = command.text.trim().split(/\s+/);
    const apiKey = parts[1];

    if (!apiKey) {
      await respond({
        response_type: "ephemeral",
        text: "❌ Usage: `/harrybotter setkey <ANTHROPIC_API_KEY>`",
      });
      return;
    }

    const validation = await validateAnthropicKey(apiKey);
    if (!validation.valid) {
      await respond({
        response_type: "ephemeral",
        text: `❌ ${validation.error}`,
      });
      return;
    }

    const hash = uHash(userId);
    const podName = `nc-${hash}`;

    try {
      await createAnthropicSecret(k8s, hash, apiKey);

      // If pod is running, restart to pick up the new key
      const podStatus = await k8s.getPodStatus(podName);
      if (podStatus?.phase === "Running") {
        await k8s.restartPod(podName);
      }

      console.log(
        `[setkey] User ${userId} set personal Anthropic key → secret=${getUserAnthropicSecretName(hash)}`
      );

      await respond({
        response_type: "ephemeral",
        text: "✅ API key set. Your bot will use your personal Anthropic account.",
      });
    } catch (err) {
      console.error(`[setkey] Failed for ${userId}:`, (err as Error).message);
      await respond({
        response_type: "ephemeral",
        text: `❌ Failed to store API key: ${(err as Error).message}`,
      });
    }
  };
}
