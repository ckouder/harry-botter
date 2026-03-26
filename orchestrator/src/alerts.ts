/**
 * Alert system for Harry Botter cluster health.
 *
 * Checks:
 *   - Pods in CrashLoopBackOff (>3 restarts)
 *   - Cluster memory usage >80% of quota
 *
 * Sends alerts to a configurable admin Slack channel.
 * Debounces: max 1 alert per pod per 15 minutes.
 */

import { WebClient } from "@slack/web-api";
import { collectMetrics, type PodMetric } from "./metrics";
import { logger } from "./logger";

const DEBOUNCE_MS = 15 * 60 * 1000; // 15 minutes
const RESTART_THRESHOLD = 3;
const MEMORY_THRESHOLD_PERCENT = 80;

// Debounce map: key → last alert timestamp
const lastAlertAt = new Map<string, number>();

function shouldAlert(key: string): boolean {
  const last = lastAlertAt.get(key);
  if (!last) return true;
  return Date.now() - last >= DEBOUNCE_MS;
}

function markAlerted(key: string): void {
  lastAlertAt.set(key, Date.now());
}

export interface AlertConfig {
  slackBotToken: string;
  adminChannelId: string;
  namespace: string;
  /** Memory quota in bytes for the namespace. Default 8Gi. */
  memoryQuotaBytes?: number;
}

/**
 * Run a single alert check cycle.
 */
export async function checkAlerts(config: AlertConfig): Promise<void> {
  const slack = new WebClient(config.slackBotToken);
  const memoryQuota = config.memoryQuotaBytes || 8 * 1024 * 1024 * 1024; // 8Gi default

  let metrics;
  try {
    metrics = await collectMetrics(config.namespace);
  } catch (err) {
    logger.error("alerts:metrics_failed", {
      action: "alerts:check",
      error: (err as Error).message,
    });
    return;
  }

  // Check for CrashLoopBackOff pods (>3 restarts)
  for (const pod of metrics.pods) {
    if (pod.restart_count > RESTART_THRESHOLD) {
      const key = `crashloop:${pod.pod_name}`;
      if (shouldAlert(key)) {
        await sendAlert(slack, config.adminChannelId, {
          type: "crashloop",
          pod,
        });
        markAlerted(key);
      }
    }
  }

  // Check cluster memory usage
  const memPercent =
    memoryQuota > 0
      ? (metrics.total_memory_bytes / memoryQuota) * 100
      : 0;
  if (memPercent > MEMORY_THRESHOLD_PERCENT) {
    const key = "cluster:memory_high";
    if (shouldAlert(key)) {
      await sendAlert(slack, config.adminChannelId, {
        type: "memory_high",
        memPercent: Math.round(memPercent),
        totalBytes: metrics.total_memory_bytes,
        quotaBytes: memoryQuota,
      });
      markAlerted(key);
    }
  }

  logger.debug("alerts:check_complete", {
    action: "alerts:check",
    pods_checked: metrics.pods.length,
    memory_percent: Math.round(memPercent),
  });
}

interface CrashloopAlert {
  type: "crashloop";
  pod: PodMetric;
}

interface MemoryAlert {
  type: "memory_high";
  memPercent: number;
  totalBytes: number;
  quotaBytes: number;
}

type AlertPayload = CrashloopAlert | MemoryAlert;

async function sendAlert(
  slack: WebClient,
  channel: string,
  alert: AlertPayload
): Promise<void> {
  let text: string;

  if (alert.type === "crashloop") {
    text = [
      `🚨 *CrashLoopBackOff Detected*`,
      ``,
      `• Pod: \`${alert.pod.pod_name}\``,
      `• User: \`${alert.pod.user_id}\``,
      `• Restarts: ${alert.pod.restart_count}`,
      `• Status: ${alert.pod.status}`,
      ``,
      `_Consider running \`/harrybotter admin kill ${alert.pod.user_id}\` to clean up._`,
    ].join("\n");
  } else {
    const usedMb = Math.round(alert.totalBytes / (1024 * 1024));
    const quotaMb = Math.round(alert.quotaBytes / (1024 * 1024));
    text = [
      `⚠️ *High Cluster Memory Usage*`,
      ``,
      `• Usage: ${alert.memPercent}% (${usedMb}Mi / ${quotaMb}Mi)`,
      ``,
      `_Review active pods with \`/harrybotter admin stats\`._`,
    ].join("\n");
  }

  try {
    await slack.chat.postMessage({ channel, text });
    logger.info("alerts:sent", {
      action: "alerts:send",
      alert_type: alert.type,
    });
  } catch (err) {
    logger.error("alerts:send_failed", {
      action: "alerts:send",
      alert_type: alert.type,
      error: (err as Error).message,
    });
  }
}

/**
 * Start the alert loop. Returns cleanup function.
 */
export function startAlertLoop(
  config: AlertConfig,
  intervalMs: number = 60_000
): () => void {
  logger.info("alerts:loop_started", {
    action: "alerts:start",
    interval_ms: intervalMs,
  });

  // Run immediately, then on interval
  checkAlerts(config).catch(() => {});

  const timer = setInterval(() => {
    checkAlerts(config).catch(() => {});
  }, intervalMs);

  return () => {
    clearInterval(timer);
    logger.info("alerts:loop_stopped", { action: "alerts:stop" });
  };
}
