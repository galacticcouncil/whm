import type { TransferRow, TransferState } from "./db";

export type TransferUpdate =
  | { kind: "created"; transfer: TransferRow }
  | { kind: "updated"; transfer: TransferRow; previousState: TransferState };

type Listener = (u: TransferUpdate) => void;

const listeners = new Set<Listener>();

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function broadcast(update: TransferUpdate): void {
  for (const fn of listeners) {
    try {
      fn(update);
    } catch {
      // swallow — a bad listener shouldn't break others
    }
  }
}
