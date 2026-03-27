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
  /** The Slack app ID (used to build the request_url) */
  appId?: string;
  /** Base URL for the event gateway (e.g. https://hb.example.com) */
  eventGatewayUrl?: string;
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
          "channels:history",
          "channels:read",
          "channels:join",
          "channels:manage",
          "groups:history",
          "groups:read",
          "groups:write",
        ],
      },
    },
    settings: {
      // Event subscriptions require a request_url when socket_mode is off.
      // On initial creation we don't have appId yet, so omit events entirely.
      // They get added in the manifest.update call after we have the appId.
      ...(opts.eventGatewayUrl && opts.appId
        ? {
            event_subscriptions: {
              request_url: `${opts.eventGatewayUrl}/slack/events/${opts.appId}`,
              bot_events: ["message.im", "message.channels", "message.groups"],
            },
          }
        : {}),
      interactivity: {
        is_enabled: false,
      },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}
