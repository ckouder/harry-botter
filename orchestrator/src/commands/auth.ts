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

    if (!argText) {
      await respond({
        response_type: "ephemeral",
        text: [
          "🔐 *Authenticate Claude Code in your bot*",
          "",
          "Copy your local Claude credentials to the pod:",
          "",
          "```",
          `kubectl cp ~/.claude/.credentials.json ${ns}/${podName}:/data/.claude/.credentials.json`,
          "```",
          "",
          "Then run: `/harrybotter auth done`",
          "",
          "This copies your existing Claude login from your machine to the bot's pod.",
        ].join("\n"),
      });
      return;
    }

    // "done" — restart pod to pick up credentials
    if (argText.toLowerCase() === "done") {
      await respond({
        response_type: "ephemeral",
        text: "⏳ Restarting pod to load credentials...",
      });

      try {
        execSync(`kubectl delete pod -n ${ns} ${podName}`, {
          timeout: 30_000,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch {}

      await respond({
        response_type: "ephemeral",
        text: [
          "✅ Pod restarting with your credentials.",
          "",
          "Give it ~30 seconds, then try messaging your bot!",
        ].join("\n"),
      });
      return;
    }

    // Direct token (sk-ant-...) — write to pod
    if (argText.startsWith("sk-ant-") || argText.startsWith("{")) {
      try {
        execSync(
          `kubectl exec -n ${ns} ${podName} -- sh -c 'mkdir -p /data/.claude'`,
          { timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] }
        );

        if (argText.startsWith("{")) {
          // JSON credentials
          const escaped = argText.replace(/'/g, "'\\''");
          execSync(
            `kubectl exec -n ${ns} ${podName} -- sh -c 'echo '"'"'${escaped}'"'"' > /data/.claude/.credentials.json'`,
            { timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] }
          );
        } else {
          // OAuth token
          execSync(
            `kubectl exec -n ${ns} ${podName} -- sh -c 'echo "${argText}" > /data/.claude/oauth_token'`,
            { timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] }
          );
        }

        // Restart pod
        try {
          execSync(`kubectl delete pod -n ${ns} ${podName}`, {
            timeout: 30_000,
            stdio: ["pipe", "pipe", "pipe"],
          });
        } catch {}

        await respond({
          response_type: "ephemeral",
          text: "✅ Credentials saved. Pod restarting — try messaging your bot in ~30 seconds!",
        });
      } catch (err) {
        await respond({
          response_type: "ephemeral",
          text: `❌ Failed: ${(err as Error).message}`,
        });
      }
      return;
    }

    await respond({
      response_type: "ephemeral",
      text: [
        "Usage:",
        "• `/harrybotter auth` — shows kubectl cp command",
        "• `/harrybotter auth done` — restart pod after copying credentials",
        "• `/harrybotter auth sk-ant-...` — set OAuth token directly",
      ].join("\n"),
    });
  };
}
