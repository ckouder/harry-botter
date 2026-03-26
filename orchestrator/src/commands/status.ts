import type {
  AllMiddlewareArgs,
  SlackCommandMiddlewareArgs,
} from "@slack/bolt";
import { Registry } from "../registry";
import type { Config } from "../config";

const STATUS_EMOJI: Record<string, string> = {
  active: "🟢",
  stopped: "🟡",
  destroyed: "🔴",
};

export function statusHandler(config: Config, registry: Registry) {
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
    const podState =
      bot.status === "active"
        ? "running (placeholder — real K8s status in M3)"
        : bot.status;

    await respond({
      response_type: "ephemeral",
      text: [
        `📊 *Harry Botter Status*`,
        ``,
        `${emoji} *Instance:* ${bot.status}`,
        `• App ID: \`${bot.app_id}\``,
        `• Pod: \`${bot.pod_name}\``,
        `• Pod State: ${podState}`,
        `• Created: ${bot.created_at}`,
        ``,
        bot.status === "active"
          ? `_DM your bot to start chatting!_`
          : `_Use \`/harrybotter create\` to spin up a new instance._`,
      ].join("\n"),
    });
  };
}
