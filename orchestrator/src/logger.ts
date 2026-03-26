/**
 * Structured JSON logger for the Harry Botter orchestrator.
 *
 * All output is JSON with consistent fields:
 *   timestamp, level, user_id, action, pod_name, duration_ms
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  user_id?: string;
  action?: string;
  pod_name?: string;
  duration_ms?: number;
  [key: string]: unknown;
}

function emit(level: LogLevel, message: string, fields: LogFields = {}): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...fields,
  };
  const line = JSON.stringify(entry);
  if (level === "error") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

export const logger = {
  debug: (msg: string, fields?: LogFields) => emit("debug", msg, fields),
  info: (msg: string, fields?: LogFields) => emit("info", msg, fields),
  warn: (msg: string, fields?: LogFields) => emit("warn", msg, fields),
  error: (msg: string, fields?: LogFields) => emit("error", msg, fields),

  /** Log a slash command invocation. */
  command(userId: string, subcommand: string, extra?: LogFields): void {
    emit("info", `command:${subcommand}`, {
      user_id: userId,
      action: `command:${subcommand}`,
      ...extra,
    });
  },

  /** Log a pod lifecycle event. */
  pod(
    action: string,
    podName: string,
    userId?: string,
    extra?: LogFields
  ): void {
    emit("info", `pod:${action}`, {
      action: `pod:${action}`,
      pod_name: podName,
      user_id: userId,
      ...extra,
    });
  },
};
