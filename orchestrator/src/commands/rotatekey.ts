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
  updateAnthropicSecret as updateUserSecret,
  hasAnthropicSecret as hasUserSecret,
  getUserAnthropicSecretName as getUserSecretName,
} from "../secrets-manager";

function userHash(userId: string): string {
  return crypto.createHash("sha256").update(userId).digest("hex").slice(0, 8);
}

export function rotatekeyHandler(
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
    const newKey = parts[1]; // parts[0] is "rotatekey"

    if (!newKey) {
      await respond({
        response_type: "ephemeral",
        text: "❌ Usage: `/harrybotter rotatekey <NEW_ANTHROPIC_API_KEY>`",
      });
      return;
    }

    const hash = userHash(userId);

    // Check that user has an existing secret to rotate
    const exists = await hasUserSecret(k8s, hash);
    if (!exists) {
      await respond({
        response_type: "ephemeral",
        text: "❌ No personal API key found. Use `/harrybotter setkey` first.",
      });
      return;
    }

    // Validate new key
    const validation = await validateAnthropicKey(newKey);
    if (!validation.valid) {
      await respond({
        response_type: "ephemeral",
        text: `❌ ${validation.error}`,
      });
      return;
    }

    const podName = `nc-${hash}`;

    try {
      // Update the K8s Secret
      await updateUserSecret(k8s, hash, newKey);

      // Restart pod to pick up new key
      const podStatus = await k8s.getPodStatus(podName, config.k8sNamespace);
      if (podStatus && podStatus.phase === "Running") {
        await k8s.restartPod(podName, config.k8sNamespace);
      }

      console.log(
        `[rotatekey] User ${userId} rotated Anthropic key → secret=${getUserSecretName(hash)}`
      );

      await respond({
        response_type: "ephemeral",
        text: "✅ API key rotated. Pod restarting...",
      });
    } catch (err) {
      console.error(
        `[rotatekey] Failed for ${userId}:`,
        (err as Error).message
      );
      await respond({
        response_type: "ephemeral",
        text: `❌ Failed to rotate API key: ${(err as Error).message}`,
      });
    }
  };
}
