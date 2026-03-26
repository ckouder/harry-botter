import type {
  AllMiddlewareArgs,
  SlackCommandMiddlewareArgs,
} from "@slack/bolt";
import * as crypto from "crypto";
import { Registry } from "../registry";
import type { Config } from "../config";
import type { K8sClient } from "../k8s-client";
import {
  deleteUserSecret,
  hasUserSecret,
  getUserSecretName,
} from "../secrets-manager";

function userHash(userId: string): string {
  return crypto.createHash("sha256").update(userId).digest("hex").slice(0, 8);
}

export function deletekeyHandler(
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
    const hash = userHash(userId);

    // Check that user has a secret to delete
    const exists = await hasUserSecret(k8s, hash, config.k8sNamespace);
    if (!exists) {
      await respond({
        response_type: "ephemeral",
        text: "🤷 No personal API key found. Nothing to delete.",
      });
      return;
    }

    const podName = `nc-${hash}`;

    try {
      // Delete the K8s Secret
      await deleteUserSecret(k8s, hash, config.k8sNamespace);

      console.log(
        `[deletekey] User ${userId} deleted Anthropic key → secret=${getUserSecretName(hash)}`
      );

      const podStatus = await k8s.getPodStatus(podName, config.k8sNamespace);

      if (config.orgAnthropicKey) {
        // Org fallback available — restart pod with org key
        if (podStatus === "running") {
          await k8s.restartPod(podName, config.k8sNamespace);
        }
        await respond({
          response_type: "ephemeral",
          text: "✅ Personal API key removed. Your bot will fall back to the org-shared key.",
        });
      } else {
        // No fallback — pod can't run without a key
        // The pod should detect missing key and stop gracefully
        await respond({
          response_type: "ephemeral",
          text: "✅ Personal API key removed. No org key configured — your bot will stop until a new key is set.",
        });
      }
    } catch (err) {
      console.error(
        `[deletekey] Failed for ${userId}:`,
        (err as Error).message
      );
      await respond({
        response_type: "ephemeral",
        text: `❌ Failed to delete API key: ${(err as Error).message}`,
      });
    }
  };
}
