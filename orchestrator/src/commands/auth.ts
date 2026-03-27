import type {
  AllMiddlewareArgs,
  SlackCommandMiddlewareArgs,
} from "@slack/bolt";
import { execSync } from "child_process";
import type { Registry } from "../registry";
import type { Config } from "../config";

export function authHandler(config: Config, registry: Registry) {
  return async ({
    command,
    ack,
    respond,
  }: SlackCommandMiddlewareArgs & AllMiddlewareArgs) => {
    await ack();

    const userId = command.user_id;
    const tokenText = (command.text || "")
      .replace(/^auth\s*/i, "")
      .trim();

    const userBot = registry.get(userId);
    if (!userBot || !userBot.pod_name) {
      await respond({
        response_type: "ephemeral",
        text: "❌ No active pod found. Complete `/harrybotter create` and `/harrybotter settoken` first.",
      });
      return;
    }

    if (!tokenText) {
      // No token provided — show instructions
      await respond({
        response_type: "ephemeral",
        text: [
          "🔐 *Authenticate Claude Code in your bot's pod*",
          "",
          "Option A — *Setup token* (easiest if you have Claude Code locally):",
          "1. On your local machine, run: `claude setup-token`",
          "2. Copy the token it outputs",
          "3. Run: `/harrybotter auth <token>`",
          "",
          "Option B — *OAuth URL* (if you don't have Claude Code locally):",
          "1. Run: `/harrybotter auth url`",
          "2. Click the URL, authenticate in browser",
          "3. Copy the code from the callback",
          "4. Run: `/harrybotter auth <code>`",
          "",
          "Option C — *API key* (uses Anthropic API billing, not Pro/Max):",
          "1. Run: `/harrybotter setkey sk-ant-your-api-key`",
        ].join("\n"),
      });
      return;
    }

    const podName = userBot.pod_name;
    const ns = config.k8sNamespace;

    await respond({
      response_type: "ephemeral",
      text: "⏳ Setting up Claude authentication in your pod...",
    });

    try {
      // Write the token/credentials into the pod
      // Try claude setup-token first (works with setup tokens)
      try {
        execSync(
          `kubectl exec -n ${ns} ${podName} -- sh -c 'mkdir -p /data/.claude && ln -sfn /data/.claude /home/nanoclaw/.claude 2>/dev/null; claude setup-token "${tokenText.replace(/"/g, '\\"')}"'`,
          { timeout: 30_000, stdio: ["pipe", "pipe", "pipe"] }
        );
        console.log(`[auth] Setup token applied for ${userId} in ${podName}`);
      } catch (setupErr) {
        // If setup-token fails, try writing it as ANTHROPIC_API_KEY
        // (for users pasting an API key instead of a setup token)
        if (tokenText.startsWith("sk-ant-")) {
          execSync(
            `kubectl exec -n ${ns} ${podName} -- sh -c 'mkdir -p /data/.claude && echo "{\\"apiKey\\":\\"${tokenText.replace(/"/g, '\\"')}\\"}" > /data/.claude/.credentials.json && ln -sfn /data/.claude /home/nanoclaw/.claude 2>/dev/null'`,
            { timeout: 15_000, stdio: ["pipe", "pipe", "pipe"] }
          );
          console.log(`[auth] API key written for ${userId} in ${podName}`);
        } else {
          throw setupErr;
        }
      }

      // Verify claude works
      try {
        const result = execSync(
          `kubectl exec -n ${ns} ${podName} -- claude -p "Say OK" --output-format text`,
          { timeout: 60_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
        );
        console.log(`[auth] Verification: ${result.trim().slice(0, 100)}`);
      } catch (verifyErr) {
        console.warn(`[auth] Verification failed (non-fatal): ${(verifyErr as Error).message}`);
      }

      await respond({
        response_type: "ephemeral",
        text: [
          "✅ Claude authenticated in your pod!",
          "",
          "Your bot is now fully operational. Try messaging it!",
        ].join("\n"),
      });
    } catch (err) {
      console.error(`[auth] Failed for ${userId}:`, (err as Error).message);
      await respond({
        response_type: "ephemeral",
        text: `❌ Authentication failed: ${(err as Error).message}`,
      });
    }
  };
}
