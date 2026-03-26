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
  private defaultNamespace: string;
  private nanoclawImage: string;

  constructor(config: Config) {
    const kc = new k8s.KubeConfig();
    if (process.env.KUBERNETES_SERVICE_HOST) {
      kc.loadFromCluster();
      console.log("[k8s] Loaded in-cluster config");
    } else {
      kc.loadFromDefault();
      console.log(`[k8s] Loaded kubeconfig (context: ${kc.getCurrentContext()})`);
    }
    this.coreApi = kc.makeApiClient(k8s.CoreV1Api);
    this.defaultNamespace = config.k8sNamespace;
    this.nanoclawImage =
      process.env.NANOCLAW_IMAGE || "harrybotter/nanoclaw-base:latest";
  }

  private ns(namespace?: string): string {
    return namespace || this.defaultNamespace;
  }

  async createPod(userId: string, botToken: string): Promise<string> {
    const name = podNameFromUserId(userId);
    const labels = userLabels(userId);

    const pod: k8s.V1Pod = {
      metadata: {
        name,
        namespace: this.defaultNamespace,
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
            imagePullPolicy: "Never",
            ports: [
              {
                name: "health",
                containerPort: 4000,
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
                    optional: true,
                  },
                },
              },
              {
                name: "ANTHROPIC_API_KEY",
                valueFrom: {
                  secretKeyRef: {
                    name: `nc-secret-${name.replace("nc-", "")}`,
                    key: "ANTHROPIC_API_KEY",
                    optional: true,
                  },
                },
              },
              {
                name: "NANOCLAW_USER_ID",
                value: userId,
              },
              {
                name: "HEALTHCHECK_PORT",
                value: "4000",
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
              httpGet: { path: "/health", port: "health" as any },
              initialDelaySeconds: 5,
              periodSeconds: 10,
              timeoutSeconds: 3,
              failureThreshold: 3,
            },
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 1001,
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
      namespace: this.defaultNamespace,
      body: pod,
    });
    return name;
  }

  async deletePod(name: string, gracePeriodSecondsOrNamespace?: number | string, gracePeriod?: number): Promise<void> {
    // Support both (name, grace) and (name, namespace, grace) signatures
    let namespace: string;
    let grace: number;
    if (typeof gracePeriodSecondsOrNamespace === "string") {
      namespace = gracePeriodSecondsOrNamespace;
      grace = gracePeriod ?? 30;
    } else {
      namespace = this.defaultNamespace;
      grace = gracePeriodSecondsOrNamespace ?? 30;
    }

    try {
      await this.coreApi.deleteNamespacedPod({
        name,
        namespace,
        gracePeriodSeconds: grace,
      });
    } catch (err: any) {
      if (err?.response?.statusCode === 404 || err?.statusCode === 404) return;
      throw err;
    }
  }

  /**
   * Get pod status. Supports both:
   *  - getPodStatus(name) — uses default namespace, returns PodStatus | null
   *  - getPodStatus(name, namespace) — for compatibility with secrets-manager etc,
   *    returns PodStatus | null (callers may compare to string "running")
   */
  async getPodStatus(name: string, namespace?: string): Promise<PodStatus | null> {
    try {
      const resp = await this.coreApi.readNamespacedPod({
        name,
        namespace: this.ns(namespace),
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
      if (err?.response?.statusCode === 404 || err?.statusCode === 404)
        return null;
      throw err;
    }
  }

  async listPods(): Promise<PodStatus[]> {
    const labelSelector = Object.entries(LABELS)
      .map(([k, v]) => `${k}=${v}`)
      .join(",");

    const resp = await this.coreApi.listNamespacedPod({
      namespace: this.defaultNamespace,
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

  /**
   * Create a K8s Secret.
   * Supports:
   *  - createSecret(userId, data) — uses default namespace, names it nc-{hash}-secret
   *  - createSecret(secretName, namespace, data) — explicit name/namespace
   */
  async createSecret(
    userIdOrName: string,
    dataOrNamespace: Record<string, string> | string,
    maybeData?: Record<string, string>
  ): Promise<string> {
    let name: string;
    let namespace: string;
    let data: Record<string, string>;

    if (typeof dataOrNamespace === "string") {
      // createSecret(secretName, namespace, data)
      name = userIdOrName;
      namespace = dataOrNamespace;
      data = maybeData!;
    } else {
      // createSecret(userId, data)
      name = `${podNameFromUserId(userIdOrName)}-secret`;
      namespace = this.defaultNamespace;
      data = dataOrNamespace;
    }

    const labels = { ...LABELS };
    const encodedData: Record<string, string> = {};
    for (const [k, v] of Object.entries(data)) {
      encodedData[k] = Buffer.from(v).toString("base64");
    }

    const secret: k8s.V1Secret = {
      metadata: { name, namespace, labels },
      type: "Opaque",
      data: encodedData,
    };

    try {
      await this.coreApi.createNamespacedSecret({
        namespace,
        body: secret,
      });
    } catch (err: any) {
      const code = err?.response?.statusCode ?? err?.statusCode ?? err?.body?.code ?? err?.code;
      const msg = String(err?.message ?? err?.body ?? "");
      if (code === 409 || msg.includes("AlreadyExists") || msg.includes("409")) {
        // Already exists — update instead
        await this.coreApi.replaceNamespacedSecret({
          name,
          namespace,
          body: secret,
        });
      } else {
        throw err;
      }
    }
    return name;
  }

  async deleteSecret(name: string, namespace?: string): Promise<void> {
    try {
      await this.coreApi.deleteNamespacedSecret({
        name,
        namespace: this.ns(namespace),
      });
    } catch (err: any) {
      if (err?.response?.statusCode === 404 || err?.statusCode === 404) return;
      throw err;
    }
  }

  async getSecret(
    name: string,
    namespace?: string
  ): Promise<k8s.V1Secret | null> {
    try {
      const resp = await this.coreApi.readNamespacedSecret({
        name,
        namespace: this.ns(namespace),
      });
      return resp;
    } catch (err: any) {
      if (err?.response?.statusCode === 404 || err?.statusCode === 404)
        return null;
      throw err;
    }
  }

  /**
   * Update a K8s Secret.
   * Supports:
   *  - updateSecret(name, data) — uses default namespace
   *  - updateSecret(name, namespace, data) — explicit namespace
   */
  async updateSecret(
    name: string,
    dataOrNamespace: Record<string, string> | string,
    maybeData?: Record<string, string>
  ): Promise<void> {
    let namespace: string;
    let data: Record<string, string>;

    if (typeof dataOrNamespace === "string") {
      namespace = dataOrNamespace;
      data = maybeData!;
    } else {
      namespace = this.defaultNamespace;
      data = dataOrNamespace;
    }

    const encodedData: Record<string, string> = {};
    for (const [k, v] of Object.entries(data)) {
      encodedData[k] = Buffer.from(v).toString("base64");
    }

    await this.coreApi.patchNamespacedSecret({
      name,
      namespace: this.ns(namespace),
      body: { data: encodedData },
    });
  }

  /**
   * Check whether a secret exists.
   */
  async secretExists(name: string, namespace?: string): Promise<boolean> {
    const secret = await this.getSecret(name, namespace);
    return secret !== null;
  }

  /**
   * Create an Anthropic-specific secret by explicit name.
   */
  async createAnthropicSecret(
    secretName: string,
    data: Record<string, string>,
    namespace?: string
  ): Promise<string> {
    const ns = this.ns(namespace);
    const encodedData: Record<string, string> = {};
    for (const [k, v] of Object.entries(data)) {
      encodedData[k] = Buffer.from(v).toString("base64");
    }

    const secret: k8s.V1Secret = {
      metadata: { name: secretName, namespace: ns, labels: { ...LABELS } },
      type: "Opaque",
      data: encodedData,
    };

    await this.coreApi.createNamespacedSecret({
      namespace: ns,
      body: secret,
    });
    return secretName;
  }

  async createService(userId: string): Promise<string> {
    const podName = podNameFromUserId(userId);
    const name = `${podName}-svc`;
    const labels = userLabels(userId);

    const svc: k8s.V1Service = {
      metadata: {
        name,
        namespace: this.defaultNamespace,
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
            port: 4000,
            targetPort: "health" as any,
            protocol: "TCP",
          },
        ],
      },
    };

    await this.coreApi.createNamespacedService({
      namespace: this.defaultNamespace,
      body: svc,
    });
    return name;
  }

  async deleteService(name: string, namespace?: string): Promise<void> {
    try {
      await this.coreApi.deleteNamespacedService({
        name,
        namespace: this.ns(namespace),
      });
    } catch (err: any) {
      if (err?.response?.statusCode === 404 || err?.statusCode === 404) return;
      throw err;
    }
  }

  /**
   * Restart a pod by deleting it (relies on K8s restartPolicy: Always).
   */
  async restartPod(name: string, namespace?: string): Promise<void> {
    await this.deletePod(name, namespace || this.defaultNamespace, 0);
  }

  /**
   * Poll until pod is ready or timeout.
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
