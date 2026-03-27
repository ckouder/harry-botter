import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Registry } from "../registry";
import * as fs from "fs";
import * as path from "path";

const TEST_DB = path.join(__dirname, "test-registry.db");

describe("Registry", () => {
  let registry: Registry;

  beforeEach(() => {
    registry = new Registry(TEST_DB);
  });

  afterEach(() => {
    registry.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      const f = TEST_DB + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  it("creates a user bot entry", () => {
    const bot = registry.create({
      slack_user_id: "U12345",
      pod_name: "nc-abc123",
      app_id: "A111",
      bot_token: "xoxb-test",
      app_config_token: "xoxe-test",
      status: "active",
      retention_mode: "retain",
      signing_secret: "ss",
      client_id: "ci",
      client_secret: "cs",
      channel_id: "",
      bot_name: "test-bot",
    });

    expect(bot.slack_user_id).toBe("U12345");
    expect(bot.pod_name).toBe("nc-abc123");

    const fetched = registry.get("U12345");
    expect(fetched).toBeDefined();
    expect(fetched!.app_id).toBe("A111");
    expect(fetched!.status).toBe("active");
  });

  it("enforces one bot per user", () => {
    registry.create({
      slack_user_id: "U12345",
      pod_name: "nc-abc123",
      app_id: "A111",
      bot_token: "xoxb-test",
      app_config_token: "xoxe-test",
      status: "active",
      retention_mode: "retain",
      signing_secret: "ss",
      client_id: "ci",
      client_secret: "cs",
      channel_id: "",
      bot_name: "test-bot",
    });

    expect(() =>
      registry.create({
        slack_user_id: "U12345",
        pod_name: "nc-abc456",
        app_id: "A222",
        bot_token: "xoxb-test2",
        app_config_token: "xoxe-test2",
        status: "active",
      retention_mode: "retain",
      signing_secret: "ss",
      client_id: "ci",
      client_secret: "cs",
      channel_id: "",
      bot_name: "test-bot",
      })
    ).toThrow();
  });

  it("returns undefined for nonexistent user", () => {
    const bot = registry.get("U_NONEXISTENT");
    expect(bot).toBeUndefined();
  });

  it("updates bot status", () => {
    registry.create({
      slack_user_id: "U12345",
      pod_name: "nc-abc123",
      app_id: "A111",
      bot_token: "xoxb-test",
      app_config_token: "xoxe-test",
      status: "active",
      retention_mode: "retain",
      signing_secret: "ss",
      client_id: "ci",
      client_secret: "cs",
      channel_id: "",
      bot_name: "test-bot",
    });

    registry.updateStatus("U12345", "destroyed");
    const bot = registry.get("U12345");
    expect(bot!.status).toBe("destroyed");
  });

  it("lists active bots", () => {
    registry.create({
      slack_user_id: "U1",
      pod_name: "nc-1",
      app_id: "A1",
      bot_token: "t1",
      app_config_token: "c1",
      status: "active",
      retention_mode: "retain",
      signing_secret: "ss",
      client_id: "ci",
      client_secret: "cs",
      channel_id: "",
      bot_name: "test-bot",
    });
    registry.create({
      slack_user_id: "U2",
      pod_name: "nc-2",
      app_id: "A2",
      bot_token: "t2",
      app_config_token: "c2",
      status: "active",
      retention_mode: "retain",
      signing_secret: "ss",
      client_id: "ci",
      client_secret: "cs",
      channel_id: "",
      bot_name: "test-bot",
    });

    const all = registry.listActive();
    expect(all.length).toBe(2);
  });

  it("counts bots", () => {
    expect(registry.count()).toBe(0);
    registry.create({
      slack_user_id: "U1",
      pod_name: "nc-1",
      app_id: "A1",
      bot_token: "t1",
      app_config_token: "c1",
      status: "active",
      retention_mode: "retain",
      signing_secret: "ss",
      client_id: "ci",
      client_secret: "cs",
      channel_id: "",
      bot_name: "test-bot",
    });
    expect(registry.count()).toBe(1);
  });

  it("deletes a bot", () => {
    registry.create({
      slack_user_id: "U1",
      pod_name: "nc-1",
      app_id: "A1",
      bot_token: "t1",
      app_config_token: "c1",
      status: "active",
      retention_mode: "retain",
      signing_secret: "ss",
      client_id: "ci",
      client_secret: "cs",
      channel_id: "",
      bot_name: "test-bot",
    });
    const deleted = registry.delete("U1");
    expect(deleted).toBe(true);
    expect(registry.get("U1")).toBeUndefined();
  });

  it("handles retention mode", () => {
    registry.create({
      slack_user_id: "U1",
      pod_name: "nc-1",
      app_id: "A1",
      bot_token: "t1",
      app_config_token: "c1",
      status: "active",
      retention_mode: "retain",
      signing_secret: "ss",
      client_id: "ci",
      client_secret: "cs",
      channel_id: "",
      bot_name: "test-bot",
    });

    // Default should be undefined or a default value
    registry.updateRetentionMode("U1", "retain");
    expect(registry.getRetentionMode("U1")).toBe("retain");

    registry.updateRetentionMode("U1", "delete");
    expect(registry.getRetentionMode("U1")).toBe("delete");
  });
});
