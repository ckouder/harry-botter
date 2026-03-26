/**
 * Orphan detector — finds mismatches between K8s pods and registry entries.
 *
 * - Pods with harrybotter labels but no matching registry entry → orphan pods
 * - Registry entries with status='active' but no matching pod → stale entries
 *
 * Designed to run on an interval (default: every 5 minutes).
 */

import { K8sClient, podNameFromUserId } from "./k8s-client";
import { Registry } from "./registry";

export interface OrphanReport {
  orphanPods: string[]; // pod names in K8s with no registry entry
  staleEntries: string[]; // user IDs in registry with no K8s pod
  cleanedPods: string[];
  updatedEntries: string[];
}

export async function detectOrphans(
  k8sClient: K8sClient,
  registry: Registry,
  opts: { autoCleanup?: boolean } = {}
): Promise<OrphanReport> {
  const report: OrphanReport = {
    orphanPods: [],
    staleEntries: [],
    cleanedPods: [],
    updatedEntries: [],
  };

  // Get all pods in namespace with harrybotter labels
  const podNames = new Set(await k8sClient.listPodNames());

  // Get all active registry entries
  const activeEntries = registry.listActive();
  const registryPodNames = new Set(activeEntries.map((e) => e.pod_name));

  // Find orphan pods: in K8s but not in registry
  for (const podName of podNames) {
    if (!registryPodNames.has(podName)) {
      report.orphanPods.push(podName);
      console.warn(`[orphan-detector] Orphan pod detected: ${podName}`);

      if (opts.autoCleanup) {
        try {
          await k8sClient.deletePod(podName);
          await k8sClient.deleteSecret(`${podName}-secret`);
          await k8sClient.deleteService(`${podName}-svc`);
          report.cleanedPods.push(podName);
          console.log(`[orphan-detector] Cleaned up orphan pod: ${podName}`);
        } catch (err) {
          console.error(
            `[orphan-detector] Failed to clean up ${podName}:`,
            (err as Error).message
          );
        }
      }
    }
  }

  // Find stale entries: in registry but not in K8s
  for (const entry of activeEntries) {
    if (!podNames.has(entry.pod_name)) {
      report.staleEntries.push(entry.slack_user_id);
      console.warn(
        `[orphan-detector] Stale registry entry: user=${entry.slack_user_id} pod=${entry.pod_name}`
      );

      if (opts.autoCleanup) {
        registry.updateStatus(entry.slack_user_id, "stopped");
        report.updatedEntries.push(entry.slack_user_id);
        console.log(
          `[orphan-detector] Marked stale entry as stopped: ${entry.slack_user_id}`
        );
      }
    }
  }

  if (
    report.orphanPods.length === 0 &&
    report.staleEntries.length === 0
  ) {
    console.log("[orphan-detector] No orphans found ✓");
  }

  return report;
}

/**
 * Start the orphan detector on an interval.
 * @returns cleanup function to stop the interval
 */
export function startOrphanDetector(
  k8sClient: K8sClient,
  registry: Registry,
  opts: { intervalMs?: number; autoCleanup?: boolean } = {}
): () => void {
  const intervalMs = opts.intervalMs ?? 5 * 60 * 1000; // 5 minutes
  const autoCleanup = opts.autoCleanup ?? false;

  console.log(
    `[orphan-detector] Starting (interval=${intervalMs}ms, autoCleanup=${autoCleanup})`
  );

  const timer = setInterval(async () => {
    try {
      await detectOrphans(k8sClient, registry, { autoCleanup });
    } catch (err) {
      console.error("[orphan-detector] Error:", (err as Error).message);
    }
  }, intervalMs);

  // Don't block process exit
  timer.unref();

  return () => {
    clearInterval(timer);
    console.log("[orphan-detector] Stopped");
  };
}
