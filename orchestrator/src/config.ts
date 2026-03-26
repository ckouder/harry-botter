/** Environment-based configuration for the orchestrator. */

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
}

function required(name: string): string {
  const val = process.env[name];
  if (!val) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return val;
}

export function loadConfig(): Config {
  return {
    slackBotToken: required("SLACK_BOT_TOKEN"),
    slackAppToken: required("SLACK_APP_TOKEN"),
    slackAppConfigurationToken: required("SLACK_APP_CONFIGURATION_TOKEN"),
    databasePath: process.env.DATABASE_PATH || "./data/harry-botter.db",
    k8sNamespace: process.env.K8S_NAMESPACE || "nanoclaw",
  };
}
