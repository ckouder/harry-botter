/**
 * Claude Code OAuth PKCE flow — implemented directly.
 * No claude CLI needed. Pure HTTP calls.
 *
 * Flow:
 * 1. Generate PKCE verifier + challenge + state
 * 2. Build authorize URL → send to user
 * 3. User authenticates in browser, gets redirected with code
 * 4. Exchange code for tokens via POST to token endpoint
 * 5. Write credentials to pod
 */

import * as crypto from "crypto";

// Actual production values from a working Claude Code OAuth flow
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const SCOPES = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

export interface OAuthSession {
  verifier: string;
  challenge: string;
  state: string;
  authorizeUrl: string;
}

export interface OAuthTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

/**
 * Start an OAuth session — generates PKCE values and returns the authorize URL.
 */
export function startOAuthSession(): OAuthSession {
  // Generate PKCE verifier (43-128 chars, base64url)
  const verifier = crypto.randomBytes(32).toString("base64url");

  // Generate challenge = base64url(sha256(verifier))
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");

  // Random state for CSRF protection
  const state = crypto.randomBytes(16).toString("base64url");

  // Build authorize URL — matches actual working Claude Code OAuth flow
  const params = new URLSearchParams();
  params.append("code", "true");
  params.append("client_id", CLIENT_ID);
  params.append("response_type", "code");
  params.append("redirect_uri", REDIRECT_URI);
  params.append("scope", SCOPES);
  params.append("code_challenge", challenge);
  params.append("code_challenge_method", "S256");
  params.append("state", state);

  const authorizeUrl = `${AUTHORIZE_URL}?${params.toString()}`;

  console.log(`[claude-oauth] Generated authorize URL: ${authorizeUrl}`);

  return { verifier, challenge, state, authorizeUrl };
}

/**
 * Exchange an authorization code for tokens.
 */
export async function exchangeCodeForTokens(
  code: string,
  session: OAuthSession
): Promise<OAuthTokens> {
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: session.verifier,
      state: session.state,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Token exchange failed (${resp.status}): ${body}`);
  }

  const data = (await resp.json()) as OAuthTokens;
  if (!data.access_token) {
    throw new Error("Token response missing access_token");
  }

  return data;
}

/**
 * Build the credentials JSON that Claude Code expects at ~/.claude/.credentials.json
 */
export function buildCredentialsJson(tokens: OAuthTokens): string {
  return JSON.stringify(
    {
      oauthAccount: {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: Date.now() + tokens.expires_in * 1000,
        scopes: SCOPES.split(" "),
        authMethod: "claude.ai",
      },
    },
    null,
    2
  );
}
