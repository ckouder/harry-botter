/** Environment-based configuration for the orchestrator. */

export type RetentionMode = "retain" | "delete";

export interface Config {
  /** Master Slack bot token (xoxb-...) */
  slackBotToken: string;
  /** Master Slack app-level token for Socket Mode (xapp-...) */
  slackAppToken: string;
  /** App Configuration Token for Manifest API (xoxe-...) */
  slackAppConfigurationToken: string;
  /** Path to SQLite database file */
  databasePath: string;
  /** Kubernetes namespace for NanoClaw pods */
  k8sNamespace: string;
  /** Default retention mode for new users ('retain' | 'delete') */
  defaultRetentionMode: RetentionMode;
  /** Maximum backup size per user in MB */
  maxBackupSizeMb: number;
  /** Base path for backup storage */
  backupBasePath: string;
  /** Org-shared Anthropic API key (fallback when user has no personal key) */
  orgAnthropicKey?: string;
  /** Comma-separated list of Slack user IDs with admin privileges */
  adminUserIds: string[];
  /** Slack channel ID for admin alerts */
  adminChannelId: string;
  /** Alert check interval in milliseconds (default 60000) */
  alertIntervalMs: number;
  /** Public URL where Slack sends events (e.g. https://hb.example.com) */
  eventGatewayUrl: string;
  /** Port for the HTTP event gateway (default 3001) */
  eventGatewayPort: number;
}

function required(name: string): string {
  const val = process.env[name];
  if (!val) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return val;
}

export function loadConfig(): Config {
  const defaultRetention = (process.env.DEFAULT_RETENTION_MODE || "retain") as RetentionMode;
  if (defaultRetention !== "retain" && defaultRetention !== "delete") {
    throw new Error(`Invalid DEFAULT_RETENTION_MODE: ${defaultRetention}`);
  }

  return {
    slackBotToken: required("SLACK_BOT_TOKEN"),
    slackAppToken: required("SLACK_APP_TOKEN"),
    slackAppConfigurationToken: required("SLACK_APP_CONFIGURATION_TOKEN"),
    databasePath: process.env.DATABASE_PATH || "./data/harry-botter.db",
    k8sNamespace: process.env.K8S_NAMESPACE || "harrybotter",
    defaultRetentionMode: defaultRetention,
    maxBackupSizeMb: parseInt(process.env.MAX_BACKUP_SIZE_MB || "1024", 10),
    backupBasePath: process.env.BACKUP_BASE_PATH || "/backups",
    orgAnthropicKey: process.env.ORG_ANTHROPIC_KEY || undefined,
    adminUserIds: (process.env.ADMIN_USER_IDS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    adminChannelId: process.env.ADMIN_CHANNEL_ID || "",
    alertIntervalMs: parseInt(process.env.ALERT_INTERVAL_MS || "60000", 10),
    eventGatewayUrl: required("EVENT_GATEWAY_URL"),
    eventGatewayPort: parseInt(process.env.EVENT_GATEWAY_PORT || "3001", 10),
  };
}
