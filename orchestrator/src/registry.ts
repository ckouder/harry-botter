import Database from "better-sqlite3";
import * as path from "path";
import * as fs from "fs";
import type { RetentionMode } from "./config";

export interface UserBot {
  slack_user_id: string;
  pod_name: string;
  app_id: string;
  bot_token: string;
  app_config_token: string;
  created_at: string;
  status: string; // "active" | "stopped" | "destroyed"
  retention_mode: RetentionMode;
}

export class Registry {
  private db: Database.Database;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_bots (
        slack_user_id TEXT PRIMARY KEY,
        pod_name TEXT NOT NULL,
        app_id TEXT NOT NULL,
        bot_token TEXT NOT NULL DEFAULT '',
        app_config_token TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        status TEXT NOT NULL DEFAULT 'active',
        retention_mode TEXT NOT NULL DEFAULT 'retain'
      );

      CREATE TABLE IF NOT EXISTS token_rotations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slack_user_id TEXT NOT NULL REFERENCES user_bots(slack_user_id),
        rotated_at TEXT NOT NULL DEFAULT (datetime('now')),
        reason TEXT
      );
    `);

    // Migration: add retention_mode column if missing (existing DBs)
    const columns = this.db
      .prepare("PRAGMA table_info(user_bots)")
      .all() as { name: string }[];
    if (!columns.some((c) => c.name === "retention_mode")) {
      this.db.exec(
        `ALTER TABLE user_bots ADD COLUMN retention_mode TEXT NOT NULL DEFAULT 'retain'`
      );
    }
  }

  get(userId: string): UserBot | undefined {
    return this.db
      .prepare("SELECT * FROM user_bots WHERE slack_user_id = ?")
      .get(userId) as UserBot | undefined;
  }

  getActive(userId: string): UserBot | undefined {
    return this.db
      .prepare(
        "SELECT * FROM user_bots WHERE slack_user_id = ? AND status = 'active'"
      )
      .get(userId) as UserBot | undefined;
  }

  create(bot: Omit<UserBot, "created_at">): UserBot {
    this.db
      .prepare(
        `INSERT INTO user_bots (slack_user_id, pod_name, app_id, bot_token, app_config_token, status, retention_mode)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        bot.slack_user_id,
        bot.pod_name,
        bot.app_id,
        bot.bot_token,
        bot.app_config_token,
        bot.status,
        bot.retention_mode
      );

    return this.get(bot.slack_user_id)!;
  }

  updateStatus(userId: string, status: string): void {
    this.db
      .prepare("UPDATE user_bots SET status = ? WHERE slack_user_id = ?")
      .run(status, userId);
  }

  updateToken(userId: string, botToken: string, reason?: string): void {
    const update = this.db.transaction(() => {
      this.db
        .prepare("UPDATE user_bots SET bot_token = ? WHERE slack_user_id = ?")
        .run(botToken, userId);

      this.db
        .prepare(
          "INSERT INTO token_rotations (slack_user_id, reason) VALUES (?, ?)"
        )
        .run(userId, reason || "manual rotation");
    });
    update();
  }

  getRetentionMode(userId: string): RetentionMode | undefined {
    const row = this.db
      .prepare("SELECT retention_mode FROM user_bots WHERE slack_user_id = ?")
      .get(userId) as { retention_mode: RetentionMode } | undefined;
    return row?.retention_mode;
  }

  updateRetentionMode(userId: string, mode: RetentionMode): void {
    this.db
      .prepare(
        "UPDATE user_bots SET retention_mode = ? WHERE slack_user_id = ?"
      )
      .run(mode, userId);
  }

  delete(userId: string): boolean {
    const result = this.db
      .prepare("DELETE FROM user_bots WHERE slack_user_id = ?")
      .run(userId);
    return result.changes > 0;
  }

  listActive(): UserBot[] {
    return this.db
      .prepare("SELECT * FROM user_bots WHERE status = 'active'")
      .all() as UserBot[];
  }

  count(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM user_bots WHERE status = 'active'")
      .get() as { count: number };
    return row.count;
  }

  close(): void {
    this.db.close();
  }
}
