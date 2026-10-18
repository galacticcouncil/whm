import { LogMessagePublishedEvt } from "../../abi";
import { CHAINS } from "../../chains";
import type { Flow, LogEvent } from "../../types";
import { vaaId } from "../vaa";

/**
 * NEAR's Wormhole core logs its own flat event: payload, emitter and sequence as hex and numbers.
 * Solana's watcher stores its publishes in the same shape, with the consistency NEAR's omits.
 */
export interface NearPublished {
  data: string;
  nonce: number;
  emitter: string;
  seq: number | string;
  consistency?: number;
}

/** What NEAR's core logs a publish as — and what Solana's are stored as. */
export const NEAR_PUBLISH = { standard: "wormhole", event: "publish" };

interface Published {
  sender: `0x${string}`;
  sequence: bigint;
  nonce: number;
  payload: `0x${string}`;
  consistencyLevel: number;
}

/**
 * Every Wormhole message our emitters publish.
 *
 * The bottom layer: NTT settlements, intent forwarding instructions, quote authorizations and
 * oracle updates all leave through the same core, and each is a row here. Whether a message exists
 * yet, at what sequence, carrying what — the question every feature otherwise has to ask
 * wormholescan.
 *
 * The core is shared with the whole chain, so which senders count is decided by the watch list's
 * topic filter rather than here.
 */
export const messages: Flow = {
  name: "messages",
  table: "wh_messages",
  key: { column: "vaa_id", type: "TEXT" },
  states: { published: 0 },
  columns: {
    chain: "TEXT",
    emitter: "TEXT",
    sequence: "BIGINT",
    nonce: "BIGINT",
    /** 200 publishes immediately, 202 waits for finality. */
    consistency: "SMALLINT",
    payload: "TEXT",
    published: "JSONB",
  },
  indexes: [
    `CREATE INDEX IF NOT EXISTS idx_wh_messages_emitter ON wh_messages (chain, emitter, sequence DESC);`,
  ],
  legs: [
    {
      role: "wormhole-core",
      abi: LogMessagePublishedEvt,
      state: "published",
      key: (a: Published, ev: LogEvent) => vaaId(CHAINS[ev.chain].wormholeId, a.sender, a.sequence),
      patch: (a: Published, ev: LogEvent) => ({
        chain: ev.chain,
        emitter: a.sender.toLowerCase(),
        sequence: a.sequence.toString(),
        nonce: a.nonce,
        consistency: a.consistencyLevel,
        payload: a.payload,
        published: ev.ref,
      }),
    },
    {
      // NEAR's core logs no consistency level: the guardians observe only final NEAR blocks and
      // sign every NEAR message at 0, so that is what its VAA carries. Solana says its own.
      role: "wormhole-core",
      near: NEAR_PUBLISH,
      state: "published",
      key: (a: NearPublished, ev: LogEvent) =>
        vaaId(CHAINS[ev.chain].wormholeId, a.emitter, BigInt(a.seq)),
      patch: (a: NearPublished, ev: LogEvent) => ({
        chain: ev.chain,
        emitter: `0x${a.emitter}`,
        sequence: String(a.seq),
        nonce: a.nonce,
        consistency: a.consistency ?? 0,
        payload: `0x${a.data}`,
        published: ev.ref,
      }),
    },
  ],
};
