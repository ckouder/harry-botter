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
  createUserSecret,
  getUserSecretName,
} from "../secrets-manager";

function userHash(userId: string): string {
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
    // command.text is "setkey <key>" — extract the key part
    const parts = command.text.trim().split(/\s+/);
    const apiKey = parts[1]; // parts[0] is "setkey"

    if (!apiKey) {
      await respond({
        response_type: "ephemeral",
        text: "❌ Usage: `/harrybotter setkey <ANTHROPIC_API_KEY>`",
      });
      return;
    }

    // Validate key format and liveness
    const validation = await validateAnthropicKey(apiKey);
    if (!validation.valid) {
      await respond({
        response_type: "ephemeral",
        text: `❌ ${validation.error}`,
      });
      return;
    }

    const hash = userHash(userId);
    const podName = `nc-${hash}`;

    try {
      // Store as K8s Secret
      await createUserSecret(k8s, hash, apiKey, config.k8sNamespace);

      // If pod is running, restart to pick up the new key
      const podStatus = await k8s.getPodStatus(podName, config.k8sNamespace);
      if (podStatus === "running") {
        await k8s.restartPod(podName, config.k8sNamespace);
      }

      // Log without the key
      console.log(
        `[setkey] User ${userId} set personal Anthropic key → secret=${getUserSecretName(hash)}`
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
