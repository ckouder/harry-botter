/**
 * Secrets management for per-user Anthropic API keys (BYOK).
 *
 * - Validates key format and liveness via Anthropic API
 * - Stores keys as K8s Secrets (never in SQLite, never logged)
 * - Supports org-shared fallback via ORG_ANTHROPIC_KEY env var
 */

import type { K8sClient } from "./k8s-client";

const SECRET_PREFIX = "nc-secret-";
const ANTHROPIC_API_BASE = "https://api.anthropic.com";

export interface KeyValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Derive the K8s Secret name for a user's Anthropic key.
 */
export function getUserSecretName(userHash: string): string {
  return `${SECRET_PREFIX}${userHash}`;
}

/**
 * Validate an Anthropic API key:
 * 1. Format check (must start with sk-ant-)
 * 2. Liveness check via lightweight API call
 */
export async function validateAnthropicKey(
  key: string
): Promise<KeyValidationResult> {
  // Format check
  if (!key.startsWith("sk-ant-")) {
    return {
      valid: false,
      error:
        "Invalid key format. Anthropic API keys start with `sk-ant-`.",
    };
  }

  // Liveness check — send a minimal request to verify the key works.
  // We use the messages endpoint with max_tokens=1 to minimise cost.
  try {
    const res = await fetch(`${ANTHROPIC_API_BASE}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    if (res.status === 401) {
      return { valid: false, error: "API key is invalid or revoked." };
    }

    if (res.status === 403) {
      return {
        valid: false,
        error: "API key lacks required permissions.",
      };
    }

    // 200 or 429 (rate limited but key is valid) are both acceptable
    if (res.ok || res.status === 429) {
      return { valid: true };
    }

    // 400 with a model-not-found is still a valid key, just wrong model
    if (res.status === 400) {
      const body = await res.json().catch(() => null);
      if (
        body?.error?.type === "invalid_request_error" &&
        body?.error?.message?.includes("model")
      ) {
        return { valid: true };
      }
    }

    return {
      valid: false,
      error: `Unexpected API response (HTTP ${res.status}). Key may be invalid.`,
    };
  } catch (err) {
    return {
      valid: false,
      error: `Could not reach Anthropic API: ${(err as Error).message}`,
    };
  }
}

/**
 * Create a K8s Secret containing the user's Anthropic API key.
 */
export async function createUserSecret(
  k8s: K8sClient,
  userHash: string,
  apiKey: string,
  namespace: string
): Promise<void> {
  const secretName = getUserSecretName(userHash);
  await k8s.createSecret(secretName, namespace, {
    ANTHROPIC_API_KEY: apiKey,
  });
}

/**
 * Update an existing K8s Secret with a new API key.
 */
export async function updateUserSecret(
  k8s: K8sClient,
  userHash: string,
  apiKey: string,
  namespace: string
): Promise<void> {
  const secretName = getUserSecretName(userHash);
  await k8s.updateSecret(secretName, namespace, {
    ANTHROPIC_API_KEY: apiKey,
  });
}

/**
 * Delete a user's K8s Secret.
 */
export async function deleteUserSecret(
  k8s: K8sClient,
  userHash: string,
  namespace: string
): Promise<void> {
  const secretName = getUserSecretName(userHash);
  await k8s.deleteSecret(secretName, namespace);
}

/**
 * Check whether the user has a personal secret stored.
 */
export async function hasUserSecret(
  k8s: K8sClient,
  userHash: string,
  namespace: string
): Promise<boolean> {
  const secretName = getUserSecretName(userHash);
  const secret = await k8s.getSecret(secretName, namespace);
  return secret !== null;
}

/**
 * Returns the effective Anthropic key source for a user.
 */
export function getEffectiveKeySource(
  hasPersonalKey: boolean,
  orgKey: string | undefined
): "personal" | "org" | "none" {
  if (hasPersonalKey) return "personal";
  if (orgKey) return "org";
  return "none";
}
