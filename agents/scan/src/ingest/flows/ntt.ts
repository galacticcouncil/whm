import { createHash } from "node:crypto";

import {
  InboundTransferQueuedEvt,
  LogMessagePublishedEvt,
  ReceivedMessageEvt,
  TransferRedeemedEvt,
} from "../../abi";
import { CHAINS } from "../../chains";
import {
  NTT_QUEUED,
  NTT_RECEIVED,
  NTT_RELEASED,
  type NttReceived,
  type NttSettled,
} from "../../chains/events";
import type { Flow, Leg, LogEvent, NearEvent } from "../../types";
import { parseNttTransfer } from "../payload";
import { vaaId } from "../vaa";
import { NEAR_PUBLISH, type NearPublished } from "./messages";

interface Published {
  sender: `0x${string}`;
  sequence: bigint;
  payload: `0x${string}`;
}

/** `ntt-<token>.transfer_sent` — names the NEAR account that sent, which the message only hashes. */
interface NearSent {
  sender: string;
  wormhole_sequence: number;
}

/** `ntt-<token>.transfer_received` / `transfer_queued_inbound` — NEAR's delivery, digest in hex. */
interface NearDelivered {
  digest: string;
  account: string;
}

/**
 * A published transfer's row, whichever chain published it.
 *
 * @param payload The transceiver payload.
 * @param emitter The emitter, as the VAA names it.
 * @param sequence The emitter's sequence.
 * @param ev The publishing event.
 */
function published(payload: string, emitter: string, sequence: bigint, ev: LogEvent) {
  const wormholeId = CHAINS[ev.chain].wormholeId;
  const t = parseNttTransfer(payload, wormholeId)!;
  return {
    vaa_id: vaaId(wormholeId, emitter, sequence),
    source_chain: ev.chain,
    source_manager: t.sourceManager,
    recipient_manager: t.recipientManager,
    manager_sequence: t.sequence?.toString() ?? null,
    sender: t.sender,
    amount: t.amount.toString(),
    decimals: t.decimals,
    source_token: t.sourceToken,
    recipient: t.to,
    to_chain: t.toChain,
    published: ev.ref,
  };
}

interface Received {
  /** NTT's own name for it, but this is the VAA hash — not the digest deliveries settle on. */
  digest: `0x${string}`;
  emitterChainId: number;
  emitterAddress: `0x${string}`;
  sequence: bigint;
}

/**
 * NTT transfers, both directions, keyed on the digest NTT itself settles on.
 *
 * Chains are indexed in parallel and at wildly different speeds, so events arrive in no particular
 * order — a destination at the tip while its source is still backfilling would have nothing to
 * attach to. The digest is the key because it is the one name every delivery event carries and the
 * source can derive: whichever side arrives first creates the row, the other merges into it, and
 * the lifecycle comes out ordered however the events did not.
 *
 * Nothing on-chain publishes that digest beside its VAA — the transceiver's `ReceivedMessage`
 * carries the VAA hash, a different value — so it is derived from the published payload, exactly as
 * NTT computes it.
 *
 * The two terminal states are exclusive at first delivery: a rate-limited transfer is queued and
 * returns before anything is credited, so `TransferRedeemed` is the release and nothing else is.
 * `completeInboundQueuedTransfer` emits it later, which is why `redeemed` outranks `queued`.
 */
export const ntt: Flow = {
  name: "ntt",
  table: "ntt_transfers",
  key: { column: "digest", type: "TEXT" },
  unique: ["vaa_id", "inbox_item"],
  states: { published: 0, received: 1, queued: 2, redeemed: 3 },
  columns: {
    /** The VAA carrying it, in `chain/emitter/sequence` form. Joins to `wh_messages`. */
    vaa_id: "TEXT",
    source_chain: "TEXT",
    source_manager: "TEXT",
    recipient_manager: "TEXT",
    /** The manager's own sequence — what a feature riding this rail correlates on. None on Solana. */
    manager_sequence: "BIGINT",
    /** Trimmed to `decimals`, the precision the rail carries rather than the token's. */
    amount: "NUMERIC",
    decimals: "SMALLINT",
    source_token: "TEXT",
    /** As the 32 bytes the message carries: an EVM caller padded, a NEAR one hashed. */
    sender: "TEXT",
    /** A NEAR sender's account — named only by its `transfer_sent`. */
    sender_account: "TEXT",
    /** As the 32 bytes the message carries; only an EVM destination trims to an address. */
    recipient: "TEXT",
    /** A NEAR recipient's account — the 32 bytes are its hash, so only the delivery can name it. */
    recipient_account: "TEXT",
    to_chain: "INTEGER",
    /** What the transceiver marks consumed. A different hash from the digest, and both matter. */
    vaa_hash: "TEXT",
    /** Solana only: the inbox item a release names — all it names, so what it is matched by. */
    inbox_item: "TEXT",
    published: "JSONB",
    received: "JSONB",
    settled: "JSONB",
  },
  indexes: [
    `CREATE INDEX IF NOT EXISTS idx_ntt_transfers_seq ON ntt_transfers (source_chain, source_manager, manager_sequence);`,
    `CREATE INDEX IF NOT EXISTS idx_ntt_transfers_recipient ON ntt_transfers (recipient);`,
  ],
  legs: [
    {
      role: "wormhole-core",
      abi: LogMessagePublishedEvt,
      state: "published",
      // The same transceiver publishes peer and init broadcasts; only transfers parse.
      key: (a: Published, ev: LogEvent) =>
        parseNttTransfer(a.payload, CHAINS[ev.chain].wormholeId)?.digest ?? null,
      patch: (a: Published, ev: LogEvent) => published(a.payload, a.sender, a.sequence, ev),
    },
    {
      role: "wormhole-core",
      near: NEAR_PUBLISH,
      state: "published",
      key: (a: NearPublished, ev: LogEvent) =>
        parseNttTransfer(`0x${a.data}`, CHAINS[ev.chain].wormholeId)?.digest ?? null,
      patch: (a: NearPublished, ev: LogEvent) =>
        published(`0x${a.data}`, a.emitter, BigInt(a.seq), ev),
    },
    {
      // The one leg that names the VAA rather than the digest, so it addresses the row the other
      // way round. It carries only a timestamp and a hash, so on the rare occasion the source has
      // not been indexed yet and there is nothing to update, nothing of substance is lost.
      role: "ntt",
      abi: ReceivedMessageEvt,
      state: "received",
      keyBy: "vaa_id",
      key: (a: Received) => vaaId(a.emitterChainId, a.emitterAddress, a.sequence),
      patch: (a: Received, ev: LogEvent) => ({ vaa_hash: a.digest, received: ev.ref }),
    },
    {
      role: "ntt",
      abi: TransferRedeemedEvt,
      state: "redeemed",
      keyBy: "digest",
      key: (a: { digest: `0x${string}` }) => a.digest,
      patch: (_a: unknown, ev: LogEvent) => ({ settled: ev.ref }),
    },
    {
      role: "ntt",
      abi: InboundTransferQueuedEvt,
      state: "queued",
      keyBy: "digest",
      key: (a: { digest: `0x${string}` }) => a.digest,
      patch: (_a: unknown, ev: LogEvent) => ({ settled: ev.ref }),
    },
    {
      // Same transaction as the publish, after it — so the row is there to find by its VAA, whose
      // emitter is the manager's own account hashed.
      role: "ntt",
      near: { standard: "whm-ntt", event: "transfer_sent" },
      state: "published",
      keyBy: "vaa_id",
      key: (a: NearSent, ev: LogEvent) =>
        vaaId(
          CHAINS[ev.chain].wormholeId,
          createHash("sha256").update(ev.address).digest("hex"),
          BigInt(a.wormhole_sequence),
        ),
      patch: (a: NearSent) => ({ sender_account: a.sender }),
    },
    {
      // NEAR verifies and releases in one call, so its delivery is the redemption — and it names
      // the account the recipient's 32 bytes only hash.
      role: "ntt",
      near: { standard: "whm-ntt", event: "transfer_received" },
      state: "redeemed",
      keyBy: "digest",
      key: (a: NearDelivered) => `0x${a.digest}`,
      patch: (a: NearDelivered, ev: LogEvent) => ({
        recipient_account: a.account,
        settled: ev.ref,
      }),
    },
    {
      role: "ntt",
      near: { standard: "whm-ntt", event: "transfer_queued_inbound" },
      state: "queued",
      keyBy: "digest",
      key: (a: NearDelivered) => `0x${a.digest}`,
      patch: (a: NearDelivered, ev: LogEvent) => ({
        recipient_account: a.account,
        settled: ev.ref,
      }),
    },
    {
      // Solana and Sui, decoded by their watchers: a verified VAA, by the digest it derives. It may
      // land before the source is indexed, so it binds the VAA id and, on Solana, the inbox item a
      // release will name.
      role: "ntt",
      near: NTT_RECEIVED,
      state: "received",
      key: (a: NttReceived) => a.digest,
      patch: (a: NttReceived, ev: LogEvent) => ({
        vaa_id: a.vaaId,
        inbox_item: a.inboxItem ?? null,
        received: ev.ref,
      }),
    },
    ...settledLegs(NTT_RELEASED, "redeemed"),
    ...settledLegs(NTT_QUEUED, "queued"),
  ],
};

/**
 * A release or a hold, from Solana or Sui: by its digest where the transaction names one, else — a
 * Solana release, which names only its inbox item — by the item its delivery bound.
 *
 * @param event The decoded event.
 * @param state The state it moves the transfer to.
 */
function settledLegs(event: NearEvent, state: string): Leg[] {
  const patch = (_a: NttSettled, ev: LogEvent) => ({ settled: ev.ref });
  return [
    {
      role: "ntt",
      near: event,
      state,
      keyBy: "digest",
      key: (a: NttSettled) => a.digest ?? null,
      patch,
    },
    {
      role: "ntt",
      near: event,
      state,
      keyBy: "inbox_item",
      key: (a: NttSettled) => (a.digest ? null : (a.inboxItem ?? null)),
      patch,
    },
  ];
}
