import type { Config } from "./config";
import type { Registry } from "./registry";

const SLACK_TOKEN_ROTATE_URL = "https://slack.com/api/tooling.tokens.rotate";
const ROTATION_INTERVAL_MS = 11 * 60 * 60 * 1000; // 11 hours
const EXPIRY_BUFFER_MS = 60 * 60 * 1000; // 1 hour before expiry

interface RotateResult {
  token: string;
  refreshToken: string;
  expiresAt: number;
}

/**
 * Rotates a Slack App Configuration Token using the refresh token.
 * Calls `tooling.tokens.rotate` and returns the new credentials.
 */
export async function rotateConfigToken(
  currentToken: string,
  refreshToken: string
): Promise<RotateResult> {
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  const res = await fetch(SLACK_TOKEN_ROTATE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Bearer ${currentToken}`,
    },
    body: body.toString(),
  });

  if (!res.ok) {
    throw new Error(
      `Token rotation HTTP error: ${res.status} ${res.statusText}`
    );
  }

  const data = (await res.json()) as {
    ok: boolean;
    token?: string;
    refresh_token?: string;
    exp?: number;
    error?: string;
  };

  if (!data.ok || !data.token || !data.refresh_token) {
    throw new Error(
      `Token rotation API error: ${data.error || "missing token in response"}`
    );
  }

  return {
    token: data.token,
    refreshToken: data.refresh_token,
    expiresAt: (data.exp || 0) * 1000, // convert seconds → ms
  };
}

/**
 * Performs a single rotation cycle: rotate the token, update config in memory,
 * and persist the new refresh token + expiry to the registry.
 */
async function performRotation(config: Config, registry: Registry): Promise<void> {
  const refreshToken =
    registry.getConfig("refresh_token") || config.slackAppConfigRefreshToken;

  if (!refreshToken) {
    console.error(
      "[token-rotation] No refresh token available. Set SLACK_APP_CONFIGURATION_REFRESH_TOKEN or persist one via registry."
    );
    return;
  }

  console.log("[token-rotation] Rotating Slack App Configuration Token...");

  const result = await rotateConfigToken(
    config.slackAppConfigurationToken,
    refreshToken
  );

  // Update config in memory
  config.slackAppConfigurationToken = result.token;
  config.slackAppConfigRefreshToken = result.refreshToken;

  // Persist to SQLite
  registry.setConfig("refresh_token", result.refreshToken);
  registry.setConfig("token_expires_at", String(result.expiresAt));

  console.log(
    "[token-rotation] Token rotated successfully. Expires at:",
    new Date(result.expiresAt).toISOString()
  );
}

/**
 * Checks whether the current token is expired or will expire within the buffer window.
 */
function isTokenExpiringSoon(registry: Registry): boolean {
  const expiresAtStr = registry.getConfig("token_expires_at");
  if (!expiresAtStr) {
    // No expiry recorded — assume we need rotation
    return true;
  }
  const expiresAt = Number(expiresAtStr);
  return Date.now() + EXPIRY_BUFFER_MS >= expiresAt;
}

/**
 * Triggers an immediate rotation. Exported so callers can invoke on 401 errors.
 */
let rotationConfig: Config | null = null;
let rotationRegistry: Registry | null = null;

export async function triggerImmediateRotation(): Promise<void> {
  if (!rotationConfig || !rotationRegistry) {
    console.error(
      "[token-rotation] Cannot trigger immediate rotation — not initialized."
    );
    return;
  }
  try {
    await performRotation(rotationConfig, rotationRegistry);
  } catch (err) {
    console.error("[token-rotation] Immediate rotation failed:", err);
  }
}

/**
 * Starts the background token rotation loop.
 * - On startup: rotates if token is expired or expiring within 1 hour.
 * - Sets an interval for every 11 hours.
 * Returns a cleanup function to stop the interval.
 */
export function startTokenRotation(
  config: Config,
  registry: Registry
): () => void {
  rotationConfig = config;
  rotationRegistry = registry;

  const refreshToken =
    registry.getConfig("refresh_token") || config.slackAppConfigRefreshToken;

  if (!refreshToken) {
    console.warn(
      "[token-rotation] No refresh token configured. Token rotation disabled."
    );
    return () => {};
  }

  // Startup check
  if (isTokenExpiringSoon(registry)) {
    performRotation(config, registry).catch((err) => {
      console.error("[token-rotation] Startup rotation failed:", err);
    });
  } else {
    console.log("[token-rotation] Token still valid. Next rotation in ~11h.");
  }

  // Periodic rotation
  const intervalId = setInterval(() => {
    performRotation(config, registry).catch((err) => {
      console.error("[token-rotation] Scheduled rotation failed:", err);
    });
  }, ROTATION_INTERVAL_MS);

  return () => {
    clearInterval(intervalId);
  };
}
