/**
 * Secrets management for per-user Anthropic API keys (BYOK).
 *
 * - Validates key format and liveness via Anthropic API
 * - Stores keys as K8s Secrets (never in SQLite, never logged)
 * - Supports org-shared fallback via ORG_ANTHROPIC_KEY env var
 */

import type { K8sClient } from "./k8s-client";

const ANTHROPIC_SECRET_PREFIX = "nc-anthro-";
const ANTHROPIC_API_BASE = "https://api.anthropic.com";

export interface KeyValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Derive the K8s Secret name for a user's Anthropic key.
 * Separate from the pod secret (nc-{hash}-secret) to avoid conflicts.
 */
export function getUserAnthropicSecretName(userHash: string): string {
  return `${ANTHROPIC_SECRET_PREFIX}${userHash}`;
}

/**
 * Validate an Anthropic API key:
 * 1. Format check (must start with sk-ant-)
 * 2. Liveness check via lightweight API call
 */
export async function validateAnthropicKey(
  key: string
): Promise<KeyValidationResult> {
  if (!key.startsWith("sk-ant-")) {
    return {
      valid: false,
      error: "Invalid key format. Anthropic API keys start with `sk-ant-`.",
    };
  }

  // Liveness check — minimal messages request
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
      return { valid: false, error: "API key lacks required permissions." };
    }

    // 200 or 429 (rate limited but key is valid) → valid
    if (res.ok || res.status === 429) {
      return { valid: true };
    }

    // 400 with model error still means key is valid
    if (res.status === 400) {
      const body = (await res.json().catch(() => null)) as {
        error?: { type?: string; message?: string };
      } | null;
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
 * Uses the K8sClient's low-level createSecret which takes userId + data.
 * We create a separate named secret for the Anthropic key.
 */
export async function createAnthropicSecret(
  k8s: K8sClient,
  userHash: string,
  apiKey: string
): Promise<string> {
  const secretName = getUserAnthropicSecretName(userHash);

  // Check if it already exists — if so, update instead
  const exists = await k8s.secretExists(secretName);
  if (exists) {
    await k8s.updateSecret(secretName, { ANTHROPIC_API_KEY: apiKey });
  } else {
    // Use low-level create — we need a custom secret name, not the pod-derived one.
    // The K8sClient.createSecret derives name from userId. For anthropic secrets
    // we use updateSecret on a pre-created secret or create directly.
    // Since K8sClient.createSecret uses userId-based naming, we'll handle
    // anthropic secrets through updateSecret after initial bootstrap.
    // For the first create, we'll need a direct method.
    await k8s.createAnthropicSecret(secretName, { ANTHROPIC_API_KEY: apiKey });
  }

  return secretName;
}

/**
 * Update an existing Anthropic key secret.
 */
export async function updateAnthropicSecret(
  k8s: K8sClient,
  userHash: string,
  apiKey: string
): Promise<void> {
  const secretName = getUserAnthropicSecretName(userHash);
  await k8s.updateSecret(secretName, { ANTHROPIC_API_KEY: apiKey });
}

/**
 * Delete a user's Anthropic key secret.
 */
export async function deleteAnthropicSecret(
  k8s: K8sClient,
  userHash: string
): Promise<void> {
  const secretName = getUserAnthropicSecretName(userHash);
  await k8s.deleteSecret(secretName);
}

/**
 * Check whether the user has a personal Anthropic key stored.
 */
export async function hasAnthropicSecret(
  k8s: K8sClient,
  userHash: string
): Promise<boolean> {
  const secretName = getUserAnthropicSecretName(userHash);
  return k8s.secretExists(secretName);
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
