/**
 * Metrics collection from K8s metrics-server API.
 *
 * Collects per-pod CPU, memory, restart count for user pods.
 * Tracks aggregate stats: pods_active, pods_total_created, pods_total_destroyed, avg_pod_age.
 */

import * as k8s from "@kubernetes/client-node";
import { logger } from "./logger";

export interface PodMetric {
  pod_name: string;
  user_id: string;
  cpu_millicores: number;
  memory_bytes: number;
  restart_count: number;
  status: string;
  age_seconds: number;
}

export interface ClusterMetrics {
  pods_active: number;
  pods_total_created: number;
  pods_total_destroyed: number;
  avg_pod_age_seconds: number;
  total_memory_bytes: number;
  pods: PodMetric[];
  collected_at: string;
}

// Running counters (reset on process restart; durable tracking via registry)
let totalCreated = 0;
let totalDestroyed = 0;

export function recordPodCreated(): void {
  totalCreated++;
}
export function recordPodDestroyed(): void {
  totalDestroyed++;
}

/**
 * Collect metrics for all user pods in the given namespace.
 */
export async function collectMetrics(
  namespace: string
): Promise<ClusterMetrics> {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();

  const coreApi = kc.makeApiClient(k8s.CoreV1Api);

  // List pods with our component label
  const podList = await coreApi.listNamespacedPod({
    namespace,
    labelSelector: "app.kubernetes.io/component=nanoclaw",
  });

  // Try to get metrics from metrics-server
  let metricsMap = new Map<string, { cpu: number; memory: number }>();
  try {
    // Use pod metrics API directly via CustomObjectsApi
    const metricsApi = kc.makeApiClient(k8s.CustomObjectsApi);
    const podMetrics = (await metricsApi.listNamespacedCustomObject({
      group: "metrics.k8s.io",
      version: "v1beta1",
      namespace,
      plural: "pods",
    })) as any;

    for (const item of (podMetrics as any).items || []) {
      const name = item.metadata.name;
      let cpu = 0;
      let mem = 0;
      for (const c of item.containers || []) {
        cpu += parseCpuValue(c.usage?.cpu || "0");
        mem += parseMemoryValue(c.usage?.memory || "0");
      }
      metricsMap.set(name, { cpu, memory: mem });
    }
  } catch {
    // metrics-server may not be available; continue without resource metrics
    logger.warn("metrics-server unavailable, skipping resource metrics");
  }

  const now = Date.now();
  const pods: PodMetric[] = [];

  for (const pod of podList.items) {
    const name = pod.metadata?.name || "unknown";
    const userId =
      pod.metadata?.labels?.["app.kubernetes.io/user-id"] || "unknown";
    const createdAt = pod.metadata?.creationTimestamp
      ? new Date(pod.metadata.creationTimestamp).getTime()
      : now;
    const ageSeconds = Math.floor((now - createdAt) / 1000);

    // Sum restart counts across all containers
    let restartCount = 0;
    for (const cs of pod.status?.containerStatuses || []) {
      restartCount += cs.restartCount;
    }

    const phase = pod.status?.phase || "Unknown";
    const metrics = metricsMap.get(name);

    pods.push({
      pod_name: name,
      user_id: userId,
      cpu_millicores: metrics?.cpu || 0,
      memory_bytes: metrics?.memory || 0,
      restart_count: restartCount,
      status: phase,
      age_seconds: ageSeconds,
    });
  }

  const activePods = pods.filter((p) => p.status === "Running").length;
  const avgAge =
    pods.length > 0
      ? pods.reduce((sum, p) => sum + p.age_seconds, 0) / pods.length
      : 0;
  const totalMem = pods.reduce((sum, p) => sum + p.memory_bytes, 0);

  const result: ClusterMetrics = {
    pods_active: activePods,
    pods_total_created: totalCreated,
    pods_total_destroyed: totalDestroyed,
    avg_pod_age_seconds: Math.round(avgAge),
    total_memory_bytes: totalMem,
    pods,
    collected_at: new Date().toISOString(),
  };

  logger.info("metrics:collected", {
    action: "metrics:collect",
    pods_active: activePods,
    pods_total: pods.length,
    total_memory_bytes: totalMem,
  });

  return result;
}

/** Parse K8s CPU string (e.g. "100m", "1") to millicores */
function parseCpuValue(val: string): number {
  if (val.endsWith("n")) return Math.round(parseInt(val) / 1_000_000);
  if (val.endsWith("u")) return Math.round(parseInt(val) / 1_000);
  if (val.endsWith("m")) return parseInt(val);
  return Math.round(parseFloat(val) * 1000);
}

/** Parse K8s memory string (e.g. "128Mi", "1Gi") to bytes */
function parseMemoryValue(val: string): number {
  const num = parseInt(val);
  if (val.endsWith("Ki")) return num * 1024;
  if (val.endsWith("Mi")) return num * 1024 * 1024;
  if (val.endsWith("Gi")) return num * 1024 * 1024 * 1024;
  if (val.endsWith("Ti")) return num * 1024 * 1024 * 1024 * 1024;
  if (val.endsWith("K") || val.endsWith("k")) return num * 1000;
  if (val.endsWith("M")) return num * 1_000_000;
  if (val.endsWith("G")) return num * 1_000_000_000;
  return num;
}
