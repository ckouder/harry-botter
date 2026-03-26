import type {
  AllMiddlewareArgs,
  SlackCommandMiddlewareArgs,
} from "@slack/bolt";
import { Registry } from "../registry";
import { K8sClient, type PodStatus } from "../k8s-client";
import type { Config } from "../config";

const STATUS_EMOJI: Record<string, string> = {
  active: "🟢",
  stopped: "🟡",
  destroyed: "🔴",
};

function formatAge(startTime: string | null): string {
  if (!startTime) return "unknown";
  const ms = Date.now() - new Date(startTime).getTime();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

export function statusHandler(
  config: Config,
  registry: Registry,
  k8sClient: K8sClient
) {
  return async ({
    command,
    ack,
    respond,
  }: SlackCommandMiddlewareArgs & AllMiddlewareArgs) => {
    await ack();

    const userId = command.user_id;
    const bot = registry.get(userId);

    if (!bot) {
      await respond({
        response_type: "ephemeral",
        text: [
          `📊 *Harry Botter Status*`,
          ``,
          `No instance found for your account.`,
          `Use \`/harrybotter create\` to get started.`,
        ].join("\n"),
      });
      return;
    }

    const emoji = STATUS_EMOJI[bot.status] || "⚪";
    let podInfo = "";

    if (bot.status === "active" && bot.pod_name) {
      try {
        const podStatus = await k8sClient.getPodStatus(bot.pod_name);
        if (podStatus) {
          const readyStr = podStatus.ready ? "✅ Yes" : "❌ No";
          podInfo = [
            `• Pod Phase: \`${podStatus.phase}\``,
            `• Ready: ${readyStr}`,
            `• Restarts: ${podStatus.restartCount}`,
            `• Age: ${formatAge(podStatus.startTime)}`,
          ].join("\n");
        } else {
          podInfo = `• Pod: ⚠️ Not found in K8s (may have been evicted)`;
        }
      } catch (err) {
        podInfo = `• Pod: ⚠️ Unable to query K8s: ${(err as Error).message}`;
      }
    } else {
      podInfo = `• Pod State: ${bot.status}`;
    }

    await respond({
      response_type: "ephemeral",
      text: [
        `📊 *Harry Botter Status*`,
        ``,
        `${emoji} *Instance:* ${bot.status}`,
        `• App ID: \`${bot.app_id}\``,
        `• Pod: \`${bot.pod_name}\``,
        podInfo,
        `• Created: ${bot.created_at}`,
        ``,
        bot.status === "active"
          ? `_DM your bot to start chatting!_`
          : `_Use \`/harrybotter create\` to spin up a new instance._`,
      ].join("\n"),
    });
  };
}
