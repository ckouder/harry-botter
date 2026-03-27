import type {
  AllMiddlewareArgs,
  SlackCommandMiddlewareArgs,
} from "@slack/bolt";
import { execSync } from "child_process";
import type { Registry } from "../registry";
import type { Config } from "../config";
import {
  startOAuthSession,
  exchangeCodeForTokens,
  buildCredentialsJson,
  type OAuthSession,
} from "../claude-oauth";

// Store pending OAuth sessions (user_id → session)
const pendingSessions = new Map<string, OAuthSession>();

export function authHandler(config: Config, registry: Registry) {
  return async ({
    command,
    ack,
    respond,
  }: SlackCommandMiddlewareArgs & AllMiddlewareArgs) => {
    await ack();

    const userId = command.user_id;
    const argText = (command.text || "").replace(/^auth\s*/i, "").trim();

    const userBot = registry.get(userId);
    if (!userBot || !userBot.pod_name) {
      await respond({
        response_type: "ephemeral",
        text: "❌ No active pod found. Complete `/harrybotter create` and `/harrybotter settoken` first.",
      });
      return;
    }

    const podName = userBot.pod_name;
    const ns = config.k8sNamespace;

    // No argument → start OAuth flow, send URL to user
    if (!argText) {
      const session = startOAuthSession();
      pendingSessions.set(userId, session);

      await respond({
        response_type: "ephemeral",
        text: [
          "🔐 *Authenticate Claude Code*",
          "",
          `1. <${session.authorizeUrl}|Click here to authenticate with Claude>`,
          "",
          "2. After logging in, you'll be redirected to a page with a *code*",
          "",
          "3. Copy the code and run:",
          "   `/harrybotter auth <paste-code-here>`",
        ].join("\n"),
      });
      return;
    }

    // User provided a code or token
    // Check if it's an OAuth code (short) or a direct token (sk-ant-oat01-)
    if (argText.startsWith("sk-ant-")) {
      // Direct OAuth token — write it to the pod
      await writeTokenToPod(ns, podName, argText, userId, respond);
      return;
    }

    // It's an OAuth authorization code — exchange for tokens
    const session = pendingSessions.get(userId);
    if (!session) {
      await respond({
        response_type: "ephemeral",
        text: [
          "❌ No pending auth session. Run `/harrybotter auth` first to get the login URL.",
          "",
          "Or if you have a token directly, run: `/harrybotter auth sk-ant-oat01-...`",
        ].join("\n"),
      });
      return;
    }

    await respond({
      response_type: "ephemeral",
      text: "⏳ Exchanging code for tokens...",
    });

    try {
      const tokens = await exchangeCodeForTokens(argText, session);
      pendingSessions.delete(userId);

      console.log(
        `[auth] Token exchange successful for ${userId} (expires_in: ${tokens.expires_in}s)`
      );

      // Write credentials to pod
      const credsJson = buildCredentialsJson(tokens);

      // Also write the access token as CLAUDE_CODE_OAUTH_TOKEN
      execSync(
        `kubectl exec -n ${ns} ${podName} -- sh -c 'mkdir -p /data/.claude && ln -sfn /data/.claude /home/nanoclaw/.claude 2>/dev/null'`,
        { timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] }
      );

      // Write credentials.json
      const escapedCreds = credsJson.replace(/'/g, "'\\''");
      execSync(
        `kubectl exec -n ${ns} ${podName} -- sh -c 'cat > /data/.claude/.credentials.json << '"'"'ENDCREDS'"'"'\n${escapedCreds}\nENDCREDS'`,
        { timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] }
      );

      // Also write the access token for entrypoint env var
      execSync(
        `kubectl exec -n ${ns} ${podName} -- sh -c 'echo "${tokens.access_token}" > /data/.claude/oauth_token'`,
        { timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] }
      );

      console.log(`[auth] Credentials written to pod ${podName}`);

      // Restart pod to pick up the token
      try {
        execSync(`kubectl delete pod -n ${ns} ${podName}`, {
          timeout: 30_000,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch {}

      await respond({
        response_type: "ephemeral",
        text: [
          "✅ Claude authenticated! Your bot is restarting.",
          "",
          "Give it ~30 seconds, then try messaging your bot!",
        ].join("\n"),
      });
    } catch (err) {
      console.error(`[auth] Token exchange failed:`, (err as Error).message);
      pendingSessions.delete(userId);
      await respond({
        response_type: "ephemeral",
        text: `❌ Authentication failed: ${(err as Error).message}`,
      });
    }
  };
}

async function writeTokenToPod(
  ns: string,
  podName: string,
  token: string,
  userId: string,
  respond: any
) {
  try {
    execSync(
      `kubectl exec -n ${ns} ${podName} -- sh -c 'mkdir -p /data/.claude && echo "${token}" > /data/.claude/oauth_token && ln -sfn /data/.claude /home/nanoclaw/.claude 2>/dev/null'`,
      { timeout: 15_000, stdio: ["pipe", "pipe", "pipe"] }
    );

    // Restart pod
    try {
      execSync(`kubectl delete pod -n ${ns} ${podName}`, {
        timeout: 30_000,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {}

    console.log(`[auth] Direct token written for ${userId}`);
    await respond({
      response_type: "ephemeral",
      text: [
        "✅ Token saved! Your bot is restarting.",
        "",
        "Give it ~30 seconds, then try messaging your bot!",
      ].join("\n"),
    });
  } catch (err) {
    await respond({
      response_type: "ephemeral",
      text: `❌ Failed to write token: ${(err as Error).message}`,
    });
  }
}
