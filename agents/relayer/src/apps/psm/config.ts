import { fromSeq, opt, rpc } from "../../config";
import { WORMHOLE } from "../../chains";

/**
 * Engine namespaces. LOAD-BEARING — every Redis key derives from them, and the two processes must
 * not share one: a shared name puts both on one queue and one set of missed-VAA cursors.
 */
export const APP_NAME_HYDRATION = opt("APP_NAME_PSM_HYDRATION", "psm-hydration-relayer");
export const APP_NAME_BASE = opt("APP_NAME_PSM_BASE", "psm-base-relayer");

export const RPC_HYDRATION = rpc("hydration", "https://hydration-rpc.n.dwellir.com");
export const RPC_BASE = rpc("base", "https://mainnet.base.org");

/**
 * Some failures here are transient by design, and the contracts keep the VAA replayable through
 * them: the vault refuses to send back a redemption that landed above its fee limit while claims
 * are paused (`ClaimsPaused`) and expects the delivery to land once they resume
 * (`docs/psm/spec.md`, "A redemption carries its own fee limit"); neither receiver takes a message
 * before its emitter is bound (a VAA from the real emitter meets `NotAuthorizedEmitter` first,
 * because the emitter check runs before `_processMessage` and the mapping is still empty;
 * `EmitterNotSet` is for a VAA that carries a zero emitter). So the budget spans an incident, as
 * basejump's does, not a blip.
 *
 * It takes both numbers. Without a backoff the engine adds no delay between attempts —
 * relayer-engine's `redis-storage` gives a job BullMQ's custom backoff only when `retryBackoffOptions`
 * is set, and a BullMQ job without one is retried at once — so ntt's and oracle's 8 attempts are
 * spent in seconds. Here the backoff is min(2^attempt * base, max), attempt from 1: 2, 4, 8, 16, 30,
 * 30, … min — 250 attempts is 5.1 days. A job that exhausts it parks in `failed` and nothing
 * re-queues it, a restart included (the spy does not replay, the missed-VAA worker counts the
 * sequence as seen, and BullMQ ignores an add for a job id that exists); the VAA stays deliverable
 * on chain, so recovery is a manual `receiveMessage` of the same bytes, which anyone may send.
 */
export const RETRIES = 250;
export const RETRY_BASE_MS = 60_000;
export const RETRY_MAX_MS = 30 * 60_000;

/**
 * Cold-start floor per source chain — missed-VAA cursors are keyed by (source chain, source
 * emitter), not by destination, so each constant is named for the source chain it is a floor
 * FOR, matching the env var it reads (`fromSeq("base")` reads `FROM_SEQ_BASE`), not for the
 * destination process that happens to consume it. A destination-keyed name here would be an
 * operator trap: the process serving Hydration as a destination consumes the floor for Base as a
 * SOURCE, so naming that constant after the destination points an operator setting `FROM_SEQ_BASE`
 * at the right env var but the wrong mental model of what it configures.
 *
 * The default floor is zero, and zero does not reach sequence 0: the missed-VAA worker's look-ahead
 * only considers sequences above the floor, and a later scan only the gaps between sequences it has
 * seen (relayer-engine 0.3.2, `missedVaasV3/check.js`). An emitter's first message is therefore
 * delivered only if the process was already running and subscribed when it was published, so both
 * processes go live before the facilitator's redeem and the vault's deposits are unpaused.
 */
export const FROM_SEQUENCE_FROM_BASE = { [WORMHOLE.base]: fromSeq("base") };
export const FROM_SEQUENCE_FROM_HYDRATION = { [WORMHOLE.hydration]: fromSeq("hydration") };
