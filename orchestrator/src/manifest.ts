/**
 * Slack App Manifest generator for per-user Harry Botter instances.
 *
 * Ref: https://api.slack.com/reference/manifests
 */

export interface ManifestOptions {
  /** Slack display name of the user */
  username: string;
  /** Unique suffix for deduplication (e.g. first 8 chars of user ID hash) */
  suffix: string;
}

export type SlackManifest = Record<string, unknown>;

/**
 * Generate a Slack app manifest for a per-user Harry Botter instance.
 *
 * Each user gets their own Slack app so messages appear from
 * "Harry Botter (username)" rather than a shared bot identity.
 */
export function generateManifest(opts: ManifestOptions): SlackManifest {
  const botName = `Harry Botter (${opts.username})`;
  // Slack app names max 35 chars
  const appName =
    botName.length > 35 ? `HB (${opts.username})`.slice(0, 35) : botName;

  return {
    _metadata: {
      major_version: 1,
      minor_version: 1,
    },
    display_information: {
      name: appName,
      description: `Personal Harry Botter instance for ${opts.username}`,
      background_color: "#1a1a2e",
    },
    features: {
      bot_user: {
        display_name: appName,
        always_online: true,
      },
    },
    oauth_config: {
      scopes: {
        bot: [
          "chat:write",
          "im:history",
          "im:read",
          "im:write",
        ],
      },
    },
    settings: {
      event_subscriptions: {
        bot_events: ["message.im"],
      },
      interactivity: {
        is_enabled: false,
      },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  };
}
