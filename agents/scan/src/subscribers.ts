/**
 * Generic, feature-tagged pub-sub for record changes. Features broadcast their own
 * row shape; consumers (the SSE stream, the startup logger) filter on `feature`.
 */
export interface RecordUpdate {
  feature: string;
  kind: "created" | "updated";
  /** the feature's row, serialized as-is to SSE clients */
  record: Record<string, unknown>;
  /** previous state on an update (null when unknown / created) */
  previousState?: string | null;
}

type Listener = (u: RecordUpdate) => void;

const listeners = new Set<Listener>();

/**
 * Register an update listener.
 *
 * @param fn callback invoked on every broadcast
 * @returns an unsubscribe function
 */
export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Fan an update out to all listeners. A throwing listener is isolated so it can't
 * break the others.
 *
 * @param update the record change to broadcast
 */
export function broadcast(update: RecordUpdate): void {
  for (const fn of listeners) {
    try {
      fn(update);
    } catch {
      // swallow — a bad listener shouldn't break others
    }
  }
}
