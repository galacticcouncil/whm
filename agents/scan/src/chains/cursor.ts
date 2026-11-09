import type { Watch } from "../types";

/**
 * The name a watch entry's cursor is kept under: its `id`, else its role.
 *
 * @param w The watch entry.
 */
export function cursorId(w: Watch): string {
  return w.id ?? w.role;
}
