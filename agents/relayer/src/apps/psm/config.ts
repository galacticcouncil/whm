import { fromSeq, opt, rpc } from "../../config";
import { WORMHOLE } from "../../chains";

/**
 * Two processes, one per destination chain, each its own engine namespace — see `../../boot`'s
 * "dist/<app>/app.js is the app" rule. Each reads its OWN env var, not a shared `APP_NAME` — that
 * is load-bearing, not a style choice: every other app in this codebase has exactly one process, so
 * `opt("APP_NAME", ...)` only ever had one reader. With two processes reading the same name, the one
 * documented use of `APP_NAME` (running a second deployment beside the live one) would collapse
 * both PSM processes onto the SAME engine namespace instead of giving each its own — same Redis
 * queue key, same missed-VAA cursors, both processes' handlers competing under one namespace whose
 * `ChainRouter` only ever holds one process's routes. A VAA the OTHER process's route would have
 * handled arrives with no registered handler and the engine throws un-actionably rather than routing
 * it nowhere obvious. Distinct names keep an override of one from ever reaching the other.
 */
export const APP_NAME_HYDRATION = opt("APP_NAME_PSM_HYDRATION", "psm-hydration-relayer");
export const APP_NAME_BASE = opt("APP_NAME_PSM_BASE", "psm-base-relayer");

export const RPC_HYDRATION = rpc("hydration", "https://hydration-rpc.n.dwellir.com");
export const RPC_BASE = rpc("base", "https://mainnet.base.org");

/** Total attempts per VAA before the engine gives up. Same policy as ntt/oracle. */
export const RETRIES = 8;

/**
 * Cold-start floor per source chain — missed-VAA cursors are keyed by (source chain, source
 * emitter), not by destination, so each constant is named for the source chain it is a floor
 * FOR, matching the env var it reads (`fromSeq("base")` reads `FROM_SEQ_BASE`), not for the
 * destination process that happens to consume it. A destination-keyed name here would be an
 * operator trap: the process serving Hydration as a destination consumes the floor for Base as a
 * SOURCE, so naming that constant after the destination points an operator setting `FROM_SEQ_BASE`
 * at the right env var but the wrong mental model of what it configures.
 *
 * Both PSM contracts are unset at this address, so this only matters once the migration runs and a
 * namespace's first run needs a floor above zero.
 */
export const FROM_SEQUENCE_FROM_BASE = { [WORMHOLE.base]: fromSeq("base") };
export const FROM_SEQUENCE_FROM_HYDRATION = { [WORMHOLE.hydration]: fromSeq("hydration") };
