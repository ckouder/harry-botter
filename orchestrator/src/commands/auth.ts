import type {
  AllMiddlewareArgs,
  SlackCommandMiddlewareArgs,
} from "@slack/bolt";
import { execSync, spawn } from "child_process";
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
        // Ensure .claude dir exists
        execSync(
          `kubectl exec -n ${ns} ${podName} -- sh -c 'mkdir -p /data/.claude && ln -sfn /data/.claude /home/nanoclaw/.claude 2>/dev/null'`,
          { timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] }
        );

        // Spawn claude setup-token — it prints a URL then waits.
        // We capture the URL and kill the process (user completes OAuth in browser).
        const url = await new Promise<string>((resolve, reject) => {
          const proc = spawn("kubectl", [
            "exec", "-n", ns, podName, "--",
            "claude", "setup-token",
          ], { stdio: ["pipe", "pipe", "pipe"] });

          let output = "";
          const timeout = setTimeout(() => {
            proc.kill();
            reject(new Error("Timed out waiting for OAuth URL"));
          }, 60_000);

          const checkForUrl = (data: Buffer) => {
            output += data.toString();
            console.log(`[auth] stdout chunk: ${data.toString().trim()}`);
            const urlMatch = output.match(/https:\/\/[^\s"'\]]+/);
            if (urlMatch) {
              clearTimeout(timeout);
              proc.kill(); // Got the URL, don't need the process anymore
              resolve(urlMatch[0]);
            }
          };

          proc.stdout?.on("data", checkForUrl);
          proc.stderr?.on("data", checkForUrl);

          proc.on("error", (err) => {
            clearTimeout(timeout);
            reject(err);
          });

          proc.on("exit", (code) => {
            clearTimeout(timeout);
            // If process exits before we find a URL, check output
            const urlMatch = output.match(/https:\/\/[^\s"'\]]+/);
            if (urlMatch) {
              resolve(urlMatch[0]);
            } else {
              reject(new Error(`setup-token exited (code ${code}) without URL. Output: ${output.slice(0, 500)}`));
            }
          });
        });

        await respond({
          response_type: "ephemeral",
          text: [
            "🔐 *Claude Authentication*",
            "",
            `1. Click to authenticate: ${url}`,
            "",
            "2. Complete the login in your browser",
            "",
            "3. Copy the token (starts with `sk-ant-oat01-...`) and run:",
            "   `/harrybotter auth sk-ant-oat01-your-token-here`",
          ].join("\n"),
        });
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
