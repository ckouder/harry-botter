/**
 * Kubernetes client wrapper for NanoClaw pod lifecycle management.
 */

import * as k8s from "@kubernetes/client-node";
import * as crypto from "crypto";
import type { Config } from "./config";

export interface PodStatus {
  name: string;
  phase: string;
  ready: boolean;
  restartCount: number;
  startTime: string | null;
  conditions: Array<{ type: string; status: string }>;
}

export function userHash(userId: string): string {
  return crypto.createHash("sha256").update(userId).digest("hex").slice(0, 12);
}

export function podNameFromUserId(userId: string): string {
  return `nc-${userHash(userId)}`;
}

const LABELS = {
  "app.kubernetes.io/name": "nanoclaw",
  "app.kubernetes.io/part-of": "harrybotter",
  "app.kubernetes.io/component": "nanoclaw-instance",
} as const;

function userLabels(userId: string): Record<string, string> {
  return {
    ...LABELS,
    "harrybotter/user-hash": userHash(userId),
  };
}

export class K8sClient {
  private coreApi: k8s.CoreV1Api;
  private namespace: string;
  private nanoclawImage: string;

  constructor(config: Config) {
    const kc = new k8s.KubeConfig();
    try {
      kc.loadFromCluster();
    } catch {
      kc.loadFromDefault();
    }
    this.coreApi = kc.makeApiClient(k8s.CoreV1Api);
    this.namespace = config.k8sNamespace;
    this.nanoclawImage =
      process.env.NANOCLAW_IMAGE || "harrybotter/nanoclaw-base:latest";
  }

  async createPod(userId: string, botToken: string): Promise<string> {
    const name = podNameFromUserId(userId);
    const labels = userLabels(userId);

    const pod: k8s.V1Pod = {
      metadata: {
        name,
        namespace: this.namespace,
        labels,
      },
      spec: {
        terminationGracePeriodSeconds: 30,
        securityContext: {
          runAsNonRoot: true,
        },
        containers: [
          {
            name: "nanoclaw",
            image: this.nanoclawImage,
            imagePullPolicy: "IfNotPresent",
            ports: [
              {
                name: "health",
                containerPort: 3000,
                protocol: "TCP",
              },
            ],
            env: [
              {
                name: "SLACK_BOT_TOKEN",
                valueFrom: {
                  secretKeyRef: {
                    name: `${name}-secret`,
                    key: "slack-bot-token",
                  },
                },
              },
              {
                name: "ANTHROPIC_API_KEY",
                valueFrom: {
                  secretKeyRef: {
                    name: "nanoclaw-secrets",
                    key: "anthropic-api-key",
                  },
                },
              },
              {
                name: "NANOCLAW_USER_ID",
                value: userId,
              },
              {
                name: "HEALTHCHECK_PORT",
                value: "3000",
              },
            ],
            resources: {
              requests: { memory: "256Mi", cpu: "100m" },
              limits: { memory: "512Mi", cpu: "500m" },
            },
            livenessProbe: {
              httpGet: { path: "/health", port: "health" as any },
              initialDelaySeconds: 10,
              periodSeconds: 15,
              timeoutSeconds: 3,
              failureThreshold: 3,
            },
            readinessProbe: {
              httpGet: { path: "/ready", port: "health" as any },
              initialDelaySeconds: 5,
              periodSeconds: 10,
              timeoutSeconds: 3,
              failureThreshold: 3,
            },
            securityContext: {
              runAsNonRoot: true,
              readOnlyRootFilesystem: true,
              allowPrivilegeEscalation: false,
              capabilities: { drop: ["ALL"] },
            },
            volumeMounts: [
              { name: "data", mountPath: "/data" },
              { name: "tmp", mountPath: "/tmp" },
            ],
          },
        ],
        volumes: [
          { name: "data", emptyDir: {} },
          { name: "tmp", emptyDir: {} },
        ],
        restartPolicy: "Always",
      },
    };

    await this.coreApi.createNamespacedPod({
      namespace: this.namespace,
      body: pod,
    });
    return name;
  }

  async deletePod(name: string, gracePeriodSeconds = 30): Promise<void> {
    try {
      await this.coreApi.deleteNamespacedPod({
        name,
        namespace: this.namespace,
        gracePeriodSeconds,
      });
    } catch (err: any) {
      if (err?.response?.statusCode === 404) return; // already gone
      throw err;
    }
  }

  async getPodStatus(name: string): Promise<PodStatus | null> {
    try {
      const resp = await this.coreApi.readNamespacedPod({
        name,
        namespace: this.namespace,
      });
      const pod = resp;
      const status = pod.status;
      const containerStatus = status?.containerStatuses?.[0];

      return {
        name: pod.metadata?.name || name,
        phase: status?.phase || "Unknown",
        ready: containerStatus?.ready || false,
        restartCount: containerStatus?.restartCount || 0,
        startTime: status?.startTime
          ? new Date(status.startTime).toISOString()
          : null,
        conditions:
          status?.conditions?.map((c) => ({
            type: c.type,
            status: c.status,
          })) || [],
      };
    } catch (err: any) {
      if (err?.response?.statusCode === 404) return null;
      throw err;
    }
  }

  async listPods(): Promise<PodStatus[]> {
    const labelSelector = Object.entries(LABELS)
      .map(([k, v]) => `${k}=${v}`)
      .join(",");

    const resp = await this.coreApi.listNamespacedPod({
      namespace: this.namespace,
      labelSelector,
    });

    return (resp.items || []).map((pod) => {
      const cs = pod.status?.containerStatuses?.[0];
      return {
        name: pod.metadata?.name || "",
        phase: pod.status?.phase || "Unknown",
        ready: cs?.ready || false,
        restartCount: cs?.restartCount || 0,
        startTime: pod.status?.startTime
          ? new Date(pod.status.startTime).toISOString()
          : null,
        conditions:
          pod.status?.conditions?.map((c) => ({
            type: c.type,
            status: c.status,
          })) || [],
      };
    });
  }

  async createSecret(
    userId: string,
    data: Record<string, string>
  ): Promise<string> {
    const name = `${podNameFromUserId(userId)}-secret`;
    const labels = userLabels(userId);

    // Base64-encode values
    const encodedData: Record<string, string> = {};
    for (const [k, v] of Object.entries(data)) {
      encodedData[k] = Buffer.from(v).toString("base64");
    }

    const secret: k8s.V1Secret = {
      metadata: {
        name,
        namespace: this.namespace,
        labels,
      },
      type: "Opaque",
      data: encodedData,
    };

    await this.coreApi.createNamespacedSecret({
      namespace: this.namespace,
      body: secret,
    });
    return name;
  }

  async deleteSecret(name: string): Promise<void> {
    try {
      await this.coreApi.deleteNamespacedSecret({
        name,
        namespace: this.namespace,
      });
    } catch (err: any) {
      if (err?.response?.statusCode === 404) return;
      throw err;
    }
  }

  async createService(userId: string): Promise<string> {
    const podName = podNameFromUserId(userId);
    const name = `${podName}-svc`;
    const labels = userLabels(userId);

    const svc: k8s.V1Service = {
      metadata: {
        name,
        namespace: this.namespace,
        labels,
      },
      spec: {
        type: "ClusterIP",
        selector: {
          "app.kubernetes.io/name": "nanoclaw",
          "harrybotter/user-hash": userHash(userId),
        },
        ports: [
          {
            name: "health",
            port: 3000,
            targetPort: "health" as any,
            protocol: "TCP",
          },
        ],
      },
    };

    await this.coreApi.createNamespacedService({
      namespace: this.namespace,
      body: svc,
    });
    return name;
  }

  async deleteService(name: string): Promise<void> {
    try {
      await this.coreApi.deleteNamespacedService({
        name,
        namespace: this.namespace,
      });
    } catch (err: any) {
      if (err?.response?.statusCode === 404) return;
      throw err;
    }
  }

  /**
   * Poll until pod is ready or timeout.
   * @returns true if ready, false if timed out
   */
  async waitForReady(
    name: string,
    timeoutMs = 60_000,
    pollMs = 2_000
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = await this.getPodStatus(name);
      if (status?.ready) return true;
      if (status?.phase === "Failed") return false;
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return false;
  }

  /** Get all pod names in namespace matching harrybotter labels */
  async listPodNames(): Promise<string[]> {
    const pods = await this.listPods();
    return pods.map((p) => p.name);
  }
}
