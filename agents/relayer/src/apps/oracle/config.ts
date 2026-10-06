import { fromSeq, opt, rpc } from "../../config";
import { WORMHOLE } from "../../chains";

/**
 * Engine namespace. LOAD-BEARING — every Redis key derives from it. Renaming orphans the existing
 * queue and missed-VAA cursors, and the worker then rescans from FROM_SEQUENCE. Overridable only so
 * a second deployment can run beside the live one.
 */
export const APP_NAME = opt("APP_NAME", "oracle-relayer");

export const RPC_HYDRATION = rpc("hydration", "https://hydration-rpc.n.dwellir.com");

/** Total attempts per VAA before the engine gives up. */
export const RETRIES = 8;

/** Cold-start floor per origin chain; ignored once a safeSequence exists in Redis. */
export const FROM_SEQUENCE = {
  [WORMHOLE.solana]: fromSeq("solana"),
  [WORMHOLE.ethereum]: fromSeq("ethereum"),
  [WORMHOLE.robinhood]: fromSeq("robinhood"),
};
