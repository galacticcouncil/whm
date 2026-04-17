import * as fs from "node:fs";
import * as path from "node:path";

import log from "./logger.js";

export interface AssetState {
  /** Last successfully sent value (18-decimal bigint as string) */
  value: string;
  /** Unix timestamp (ms) of last send */
  sentAt: number;
}

/** Maps asset ID (base58 pubkey) -> last sent state */
export type BroadcasterState = Record<string, AssetState>;

/** Maps asset ID (base58 pubkey) -> threshold as a fraction (0.01 = 1%). */
export type ThresholdMap = Record<string, number>;

export function loadState(filePath: string): BroadcasterState {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as BroadcasterState;
  } catch {
    return {};
  }
}

export function loadThresholds(filePath: string): ThresholdMap {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, number>;
    const result: ThresholdMap = {};
    for (const [k, v] of Object.entries(parsed)) {
      result[k] = v / 100;
    }
    log.info(`Loaded ${Object.keys(result).length} per-asset thresholds from ${filePath}`);
    return result;
  } catch {
    log.info(`No threshold overrides at ${filePath}, using default for all feeds`);
    return {};
  }
}

export function saveState(filePath: string, state: BroadcasterState): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2) + "\n");
}
