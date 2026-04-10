import * as fs from "node:fs";
import * as path from "node:path";

export interface AssetState {
  /** Last successfully sent value (18-decimal bigint as string) */
  value: string;
  /** Unix timestamp (ms) of last send */
  sentAt: number;
}

/** Maps asset ID hex -> last sent state */
export type BroadcasterState = Record<string, AssetState>;

export function loadState(filePath: string): BroadcasterState {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as BroadcasterState;
  } catch {
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
