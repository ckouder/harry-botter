/**
 * Pod proxy — maintains kubectl port-forwards to NanoClaw pods.
 * When running outside K8s, pod IPs aren't routable. This module
 * manages port-forwards so the orchestrator can reach pods via localhost.
 */

import { execSync, spawn, ChildProcess } from "child_process";

const PORT_FORWARDS = new Map<
  string,
  { process: ChildProcess; localPort: number }
>();
let nextPort = 14000; // Start allocating from port 14000

/**
 * Get a localhost URL to reach a pod's HTTP endpoint.
 * Starts a kubectl port-forward if one doesn't exist.
 */
export async function getPodUrl(
  podName: string,
  namespace: string,
  remotePort: number = 4000
): Promise<string> {
  const key = `${namespace}/${podName}`;

  // Check if we already have a port-forward
  const existing = PORT_FORWARDS.get(key);
  if (existing && !existing.process.killed) {
    return `http://localhost:${existing.localPort}`;
  }

  // Allocate a local port
  const localPort = nextPort++;
  
  // Start port-forward
  const pf = spawn("kubectl", [
    "port-forward",
    `-n`, namespace,
    podName,
    `${localPort}:${remotePort}`,
  ], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  PORT_FORWARDS.set(key, { process: pf, localPort });

  pf.on("exit", () => {
    PORT_FORWARDS.delete(key);
  });

  // Wait for port-forward to be ready
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Port-forward timeout"));
    }, 10000);

    const onData = (data: Buffer) => {
      const msg = data.toString();
      if (msg.includes("Forwarding")) {
        clearTimeout(timeout);
        pf.stdout?.removeListener("data", onData);
        resolve();
      }
    };

    pf.stdout?.on("data", onData);
    pf.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  console.log(`[pod-proxy] Port-forward ${podName} → localhost:${localPort}`);
  return `http://localhost:${localPort}`;
}

/**
 * Stop all port-forwards.
 */
export function stopAllPortForwards(): void {
  for (const [key, { process }] of PORT_FORWARDS) {
    process.kill();
    PORT_FORWARDS.delete(key);
  }
}

/**
 * Stop port-forward for a specific pod.
 */
export function stopPortForward(podName: string, namespace: string): void {
  const key = `${namespace}/${podName}`;
  const existing = PORT_FORWARDS.get(key);
  if (existing) {
    existing.process.kill();
    PORT_FORWARDS.delete(key);
  }
}
