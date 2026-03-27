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

    // If no argument — run `claude setup-token` in pod, capture URL, send to user
    if (!argText) {
      await respond({
        response_type: "ephemeral",
        text: "🔐 Starting Claude authentication... one moment.",
      });

      try {
        // Run claude setup-token in the pod and capture output
        const output = execSync(
          `kubectl exec -n ${ns} ${podName} -- sh -c 'mkdir -p /data/.claude && ln -sfn /data/.claude /home/nanoclaw/.claude 2>/dev/null; claude setup-token 2>&1 || true'`,
          { timeout: 30_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
        );

        console.log(`[auth] setup-token output: ${output.slice(0, 500)}`);

        // Extract URL from output (look for https:// URLs)
        const urlMatch = output.match(/https:\/\/[^\s"']+/);
        
        if (urlMatch) {
          await respond({
            response_type: "ephemeral",
            text: [
              "🔐 *Claude Authentication*",
              "",
              `1. Click this link to authenticate: ${urlMatch[0]}`,
              "",
              "2. Complete the login in your browser",
              "",
              "3. Copy the token (starts with `sk-ant-oat01-...`) and run:",
              "   `/harrybotter auth sk-ant-oat01-your-token-here`",
            ].join("\n"),
          });
        } else {
          // No URL found — show raw output for debugging
          await respond({
            response_type: "ephemeral",
            text: [
              "🔐 *Claude setup-token output:*",
              "```",
              output.slice(0, 2000),
              "```",
              "",
              "If you see a token (`sk-ant-oat01-...`), run:",
              "`/harrybotter auth <your-token>`",
            ].join("\n"),
          });
        }
      } catch (err) {
        console.error(`[auth] setup-token failed:`, (err as Error).message);
        await respond({
          response_type: "ephemeral",
          text: `❌ Failed to start auth: ${(err as Error).message}`,
        });
      }
      return;
    }

    // User provided a token — write it to the pod
    await respond({
      response_type: "ephemeral",
      text: "⏳ Saving token to your pod...",
    });

    try {
      // Write the OAuth token to persistent storage
      execSync(
        `kubectl exec -n ${ns} ${podName} -- sh -c 'mkdir -p /data/.claude && echo "${argText.replace(/"/g, '\\"')}" > /data/.claude/oauth_token'`,
        { timeout: 15_000, stdio: ["pipe", "pipe", "pipe"] }
      );
      console.log(`[auth] OAuth token written to pod ${podName}`);

      // Verify claude works
      await respond({
        response_type: "ephemeral",
        text: "⏳ Verifying Claude access...",
      });

      try {
        const result = execSync(
          `kubectl exec -n ${ns} ${podName} -- sh -c 'CLAUDE_CODE_OAUTH_TOKEN=$(cat /data/.claude/oauth_token) claude -p "Say OK" --output-format text'`,
          { timeout: 120_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
        );
        console.log(`[auth] Verified: ${result.trim().slice(0, 100)}`);

        // Restart the pod to pick up the token via entrypoint
        try {
          execSync(
            `kubectl delete pod -n ${ns} ${podName}`,
            { timeout: 30_000, stdio: ["pipe", "pipe", "pipe"] }
          );
          console.log(`[auth] Pod ${podName} restarting to load token`);
        } catch {}

        await respond({
          response_type: "ephemeral",
          text: [
            "✅ Claude authenticated! Your bot is restarting to load the token.",
            "",
            "Give it ~30 seconds, then try messaging your bot!",
          ].join("\n"),
        });
      } catch (verifyErr) {
        // Token saved even if verification fails — might work after restart
        console.warn(`[auth] Verification failed: ${(verifyErr as Error).message}`);

        // Still restart to pick up the token
        try {
          execSync(
            `kubectl delete pod -n ${ns} ${podName}`,
            { timeout: 30_000, stdio: ["pipe", "pipe", "pipe"] }
          );
        } catch {}

        await respond({
          response_type: "ephemeral",
          text: [
            "⚠️ Token saved. Verification was slow (Claude may need a moment).",
            "",
            "Your pod is restarting. Try messaging your bot in ~30 seconds.",
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
