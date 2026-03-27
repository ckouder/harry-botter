/**
 * Data persistence manager for Harry Botter user pods.
 *
 * Handles export (tar + copy from pod), import (copy + untar into pod),
 * cleanup, and backup inventory. Uses K8s exec API to run tar inside
 * the container and streams data to/from the shared backup PV.
 */

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import type { Config } from "./config";

export interface BackupInfo {
  filename: string;
  path: string;
  timestamp: string;
  sizeBytes: number;
  sizeMb: number;
}

/**
 * Get the backup directory for a user.
 */
function backupDir(config: Config, userHash: string): string {
  return path.join(config.backupBasePath, "backups", userHash);
}

/**
 * Get total backup size for a user in bytes.
 */
function getUserBackupSize(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  const files = fs.readdirSync(dir);
  return files.reduce((total, file) => {
    const stat = fs.statSync(path.join(dir, file));
    return total + stat.size;
  }, 0);
}

/**
 * Export /data from a running pod to a backup tarball.
 *
 * Runs `tar czf` inside the container, then uses `kubectl cp` to
 * pull the archive out.
 */
export async function exportPodData(
  config: Config,
  podName: string,
  userHash: string
): Promise<BackupInfo> {
  const dir = backupDir(config, userHash);
  fs.mkdirSync(dir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${timestamp}.tar.gz`;
  const destPath = path.join(dir, filename);
  const ns = config.k8sNamespace;

  // Create tar inside the pod, then copy it out
  const remoteTar = `/tmp/backup-${timestamp}.tar.gz`;

  execSync(
    `kubectl exec -n ${ns} ${podName} -- tar czf ${remoteTar} -C / data 2>/dev/null || true`,
    { stdio: "pipe", timeout: 300_000 }
  );

  execSync(
    `kubectl cp ${ns}/${podName}:${remoteTar} ${destPath}`,
    { stdio: "pipe", timeout: 300_000 }
  );

  // Clean up temp tar inside pod
  execSync(
    `kubectl exec -n ${ns} ${podName} -- rm -f ${remoteTar}`,
    { stdio: "pipe", timeout: 10_000 }
  );

  // Verify size limit
  const stat = fs.statSync(destPath);
  const totalBytes = getUserBackupSize(dir);
  const limitBytes = config.maxBackupSizeMb * 1024 * 1024;

  if (totalBytes > limitBytes) {
    // Remove the backup we just made — over limit
    fs.unlinkSync(destPath);
    throw new Error(
      `Backup size limit exceeded (${config.maxBackupSizeMb}MB). ` +
        `Total would be ${(totalBytes / 1024 / 1024).toFixed(1)}MB. ` +
        `Delete old backups first.`
    );
  }

  return {
    filename,
    path: destPath,
    timestamp: new Date().toISOString(),
    sizeBytes: stat.size,
    sizeMb: Math.round((stat.size / 1024 / 1024) * 100) / 100,
  };
}

/**
 * Import the latest backup into a pod's /data directory.
 */
export async function importPodData(
  config: Config,
  podName: string,
  userHash: string
): Promise<BackupInfo | null> {
  const latest = getLatestBackup(config, userHash);
  if (!latest) return null;

  const ns = config.k8sNamespace;
  const remoteTar = `/tmp/restore-${Date.now()}.tar.gz`;

  // Copy tarball into pod
  execSync(
    `kubectl cp ${latest.path} ${ns}/${podName}:${remoteTar}`,
    { stdio: "pipe", timeout: 300_000 }
  );

  // Extract into root (tar was created with -C / data, so it extracts to /data)
  execSync(
    `kubectl exec -n ${ns} ${podName} -- tar xzf ${remoteTar} -C / --no-same-owner --no-same-permissions`,
    { stdio: "pipe", timeout: 300_000 }
  );

  // Clean up
  execSync(
    `kubectl exec -n ${ns} ${podName} -- rm -f ${remoteTar}`,
    { stdio: "pipe", timeout: 10_000 }
  );

  return latest;
}

/**
 * Delete all backups for a user.
 */
export function cleanupBackups(config: Config, userHash: string): number {
  const dir = backupDir(config, userHash);
  if (!fs.existsSync(dir)) return 0;

  const files = fs.readdirSync(dir);
  for (const file of files) {
    fs.unlinkSync(path.join(dir, file));
  }
  fs.rmdirSync(dir);
  return files.length;
}

/**
 * List all backups for a user with metadata.
 */
export function getBackupInfo(config: Config, userHash: string): BackupInfo[] {
  const dir = backupDir(config, userHash);
  if (!fs.existsSync(dir)) return [];

  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".tar.gz"))
    .map((filename) => {
      const filePath = path.join(dir, filename);
      const stat = fs.statSync(filePath);
      // Parse timestamp from filename: 2026-03-25T23-21-00-000Z.tar.gz
      const tsStr = filename.replace(".tar.gz", "").replace(/-/g, (m, i) => {
        // Restore ISO format: first 2 dashes are date separators
        return i < 10 ? "-" : ":";
      });
      return {
        filename,
        path: filePath,
        timestamp: stat.mtime.toISOString(),
        sizeBytes: stat.size,
        sizeMb: Math.round((stat.size / 1024 / 1024) * 100) / 100,
      };
    })
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

/**
 * Get the most recent backup for a user, or null.
 */
export function getLatestBackup(
  config: Config,
  userHash: string
): BackupInfo | null {
  const backups = getBackupInfo(config, userHash);
  return backups.length > 0 ? backups[0] : null;
}
