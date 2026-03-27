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
      await respond({
        response_type: "ephemeral",
        text: [
          "🔐 *Authenticate Claude Code in your bot*",
          "",
          "*Step 1:* Run this in your pod:",
          `\`kubectl exec -it -n ${config.k8sNamespace} ${userBot.pod_name} -- claude setup-token\``,
          "",
          "*Step 2:* Complete the OAuth flow in your browser",
          "",
          "*Step 3:* Copy the token (`sk-ant-oat01-...`) and run:",
          "`/harrybotter auth sk-ant-oat01-your-token`",
          "",
          "Or if you already have the token from another machine, just paste it directly.",
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
      // Write the OAuth token to the pod's persistent volume
      // NanoClaw/Claude Code will pick it up via CLAUDE_CODE_OAUTH_TOKEN env var
      // We write it to a file that the entrypoint sources
      execSync(
        `kubectl exec -n ${ns} ${podName} -- sh -c 'mkdir -p /data/.claude && echo "${tokenText.replace(/"/g, '\\"')}" > /data/.claude/oauth_token'`,
        { timeout: 15_000, stdio: ["pipe", "pipe", "pipe"] }
      );
      console.log(`[auth] OAuth token written to pod ${podName}`);

      // Verify claude works with the token
      await respond({
        response_type: "ephemeral",
        text: "⏳ Token saved. Verifying Claude access...",
      });

      try {
        const result = execSync(
          `kubectl exec -n ${ns} ${podName} -- sh -c 'CLAUDE_CODE_OAUTH_TOKEN=$(cat /data/.claude/oauth_token) claude -p "Say OK" --output-format text'`,
          { timeout: 120_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
        );
        console.log(`[auth] Verification: ${result.trim().slice(0, 100)}`);

        await respond({
          response_type: "ephemeral",
          text: [
            "✅ Claude authenticated in your pod!",
            "",
            "Your bot is now fully operational. Try messaging it!",
          ].join("\n"),
        });
      } catch (verifyErr) {
        console.warn(`[auth] Verification failed: ${(verifyErr as Error).message}`);
        await respond({
          response_type: "ephemeral",
          text: [
            "⚠️ Token saved but verification failed.",
            "The token may still work — try messaging your bot.",
            `Error: ${(verifyErr as Error).message.slice(0, 200)}`,
          ].join("\n"),
        });
      }
    } catch (err) {
      console.error(`[auth] Failed for ${userId}:`, (err as Error).message);
      await respond({
        response_type: "ephemeral",
        text: `❌ Authentication failed: ${(err as Error).message}`,
      });
    }
  };
}
