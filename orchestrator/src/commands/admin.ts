/**
 * Admin commands for Harry Botter orchestrator.
 *
 * /harrybotter admin list   — all pods (name, user, status, age, restarts, memory)
 * /harrybotter admin kill <user_id_or_hash> — force destroy a user's pod
 * /harrybotter admin stats  — cluster summary
 *
 * Restricted to users listed in ADMIN_USER_IDS.
 */

import type {
  AllMiddlewareArgs,
  SlackCommandMiddlewareArgs,
} from "@slack/bolt";
import * as k8s from "@kubernetes/client-node";
import { Registry } from "../registry";
import { collectMetrics } from "../metrics";
import { logger } from "../logger";
import type { Config } from "../config";

function isAdmin(userId: string, adminIds: string[]): boolean {
  return adminIds.includes(userId);
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}Ki`;
  if (bytes < 1024 * 1024 * 1024)
    return `${Math.round(bytes / (1024 * 1024))}Mi`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}Gi`;
}

export function adminHandler(config: Config, registry: Registry) {
  return async ({
    command,
    ack,
    respond,
  }: SlackCommandMiddlewareArgs & AllMiddlewareArgs) => {
    await ack();

    const userId = command.user_id;

    if (!isAdmin(userId, config.adminUserIds)) {
      await respond({
        response_type: "ephemeral",
        text: "🔒 You do not have permission to use admin commands.",
      });
      return;
    }

    // Parse: "admin <subcommand> [args]"
    const parts = (command.text || "").trim().split(/\s+/);
    // parts[0] = "admin", parts[1] = subcommand, parts[2..] = args
    const sub = parts[1] || "help";
    const args = parts.slice(2);

    logger.command(userId, `admin:${sub}`);

    switch (sub) {
      case "list":
        return handleList(config, respond);
      case "kill":
        return handleKill(config, registry, args, respond);
      case "stats":
        return handleStats(config, respond);
      default:
        await respond({
          response_type: "ephemeral",
          text: [
            `🔧 *Admin Commands*`,
            ``,
            `\`/harrybotter admin list\` — Show all pods`,
            `\`/harrybotter admin kill <user_id_or_hash>\` — Force destroy a pod`,
            `\`/harrybotter admin stats\` — Cluster summary`,
          ].join("\n"),
        });
    }
  };
}

async function handleList(
  config: Config,
  respond: (msg: any) => Promise<any>
): Promise<void> {
  try {
    const metrics = await collectMetrics(config.k8sNamespace);

    if (metrics.pods.length === 0) {
      await respond({
        response_type: "ephemeral",
        text: "📋 No active pods found.",
      });
      return;
    }

    const lines = metrics.pods.map(
      (p) =>
        `• \`${p.pod_name}\` | user: \`${p.user_id}\` | ${p.status} | age: ${formatAge(p.age_seconds)} | restarts: ${p.restart_count} | mem: ${formatBytes(p.memory_bytes)}`
    );

    await respond({
      response_type: "ephemeral",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `📋 *Active Pods (${metrics.pods.length})*\n\n${lines.join("\n")}`,
          },
        },
      ],
    });
  } catch (err) {
    logger.error("admin:list_failed", { error: (err as Error).message });
    await respond({
      response_type: "ephemeral",
      text: `❌ Failed to list pods: ${(err as Error).message}`,
    });
  }
}

async function handleKill(
  config: Config,
  registry: Registry,
  args: string[],
  respond: (msg: any) => Promise<any>
): Promise<void> {
  const target = args[0];
  if (!target) {
    await respond({
      response_type: "ephemeral",
      text: "Usage: `/harrybotter admin kill <user_id_or_hash>`",
    });
    return;
  }

  try {
    // Find matching bot — by user ID or pod name hash
    const activeBots = registry.listActive();
    const bot = activeBots.find(
      (b) =>
        b.slack_user_id === target ||
        b.pod_name === target ||
        b.pod_name.endsWith(target)
    );

    if (!bot) {
      await respond({
        response_type: "ephemeral",
        text: `🤷 No active bot found matching \`${target}\`.`,
      });
      return;
    }

    // Delete K8s pod
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);

    try {
      await coreApi.deleteNamespacedPod(bot.pod_name, config.k8sNamespace);
    } catch (err: any) {
      if (err?.statusCode !== 404) throw err;
      // Already gone, fine
    }

    registry.updateStatus(bot.slack_user_id, "destroyed");

    logger.pod("admin_kill", bot.pod_name, bot.slack_user_id);

    await respond({
      response_type: "ephemeral",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: [
              `💀 *Pod Force Destroyed*`,
              ``,
              `• Pod: \`${bot.pod_name}\``,
              `• User: \`${bot.slack_user_id}\``,
              `• Registry status set to \`destroyed\``,
            ].join("\n"),
          },
        },
      ],
    });
  } catch (err) {
    logger.error("admin:kill_failed", {
      target,
      error: (err as Error).message,
    });
    await respond({
      response_type: "ephemeral",
      text: `❌ Failed to kill pod: ${(err as Error).message}`,
    });
  }
}

async function handleStats(
  config: Config,
  respond: (msg: any) => Promise<any>
): Promise<void> {
  try {
    const metrics = await collectMetrics(config.k8sNamespace);
    const uptimeSeconds = Math.floor(process.uptime());

    await respond({
      response_type: "ephemeral",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: [
              `📊 *Cluster Summary*`,
              ``,
              `• Active pods: ${metrics.pods_active}`,
              `• Total created: ${metrics.pods_total_created}`,
              `• Total destroyed: ${metrics.pods_total_destroyed}`,
              `• Avg pod age: ${formatAge(metrics.avg_pod_age_seconds)}`,
              `• Total memory: ${formatBytes(metrics.total_memory_bytes)}`,
              `• Orchestrator uptime: ${formatAge(uptimeSeconds)}`,
            ].join("\n"),
          },
        },
      ],
    });
  } catch (err) {
    logger.error("admin:stats_failed", { error: (err as Error).message });
    await respond({
      response_type: "ephemeral",
      text: `❌ Failed to get stats: ${(err as Error).message}`,
    });
  }
}
