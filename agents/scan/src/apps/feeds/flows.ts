import { base58 } from "@scure/base";
import { pad } from "viem";

import { LogMessagePublishedEvt } from "../../abi";
import { wormholeId } from "../../chains";
import { PUBLISH, type Publish } from "../../chains/events";
import { ORACLE } from "../../deployments";
import { vaaId } from "../../ingest/vaa";
import type { Flow, LogEvent } from "../../types";

import { PriceReceivedEvt } from "./abi";

/** Each relay's emitter as the VAA names it — 32 bytes — by source chain. */
const EMITTERS = new Map<string, string>(
  Object.entries(ORACLE).map(([chain, r]) => [
    chain,
    chain === "solana"
      ? `0x${Buffer.from(base58.decode(r.emitter)).toString("hex")}`
      : pad(r.emitter as `0x${string}`, { size: 32 }),
  ]),
);

/** The EVM chains a relay publishes from. */
const EVM_SOURCES = Object.keys(ORACLE).filter((c) => c !== "solana");

/** Each receiver's source chain, by its address. */
const SOURCE_OF = new Map<string, string>(
  Object.entries(ORACLE).map(([chain, r]) => [r.receiver.address.toLowerCase(), chain]),
);

/** An update as the payload carries it: `abi.encode(uint8 action, bytes32 assetId, uint256 value, uint64 timestamp)`. */
interface Update {
  action: number;
  assetId: `0x${string}`;
  value: bigint;
}

/**
 * Read an oracle payload, or null for anything else.
 *
 * @param payload Hex.
 */
function update(payload: string): Update | null {
  const b = Buffer.from(payload.replace(/^0x/, ""), "hex");
  if (b.length !== 128) return null;
  const action = b[31];
  if (action !== 1 && action !== 2) return null;
  return {
    action,
    assetId: `0x${b.subarray(32, 64).toString("hex")}`,
    value: BigInt(`0x${b.subarray(64, 96).toString("hex")}`),
  };
}

/**
 * An update's identity: its source, its asset, and the VAA's timestamp — the one thing the
 * receiver's `PriceReceived` shares with the publish.
 *
 * @param source Source chain.
 * @param assetId As the payload carries it.
 * @param vaaTime Unix seconds.
 */
const key = (source: string, assetId: string, vaaTime: number | bigint) =>
  `${source}:${assetId.toLowerCase()}:${vaaTime}`;

/**
 * A publish's row, whichever chain published it — or null when it is not one of our relays'.
 *
 * @param emitter The emitter, 32 bytes.
 * @param sequence The emitter's sequence.
 * @param payload The payload.
 * @param ev The publishing event.
 * @param vaaTime The VAA's timestamp: what the chain states, else the block's.
 */
function published(
  emitter: string,
  sequence: bigint,
  payload: string,
  ev: LogEvent,
  vaaTime = Math.floor(ev.ref.blockTimestamp / 1000),
) {
  if (EMITTERS.get(ev.chain) !== pad(emitter as `0x${string}`, { size: 32 }).toLowerCase()) {
    return null;
  }
  const u = update(payload);
  if (!u) return null;
  return {
    key: key(ev.chain, u.assetId, vaaTime),
    patch: {
      source_chain: ev.chain,
      asset_id: u.assetId.toLowerCase(),
      vaa_time: vaaTime,
      action: u.action,
      value: u.value.toString(),
      emitter: emitter.toLowerCase(),
      sequence: sequence.toString(),
      vaa_id: vaaId(wormholeId(ev.chain), emitter, sequence),
      published: ev.ref,
    },
  };
}

interface Logged {
  sender: `0x${string}`;
  sequence: bigint;
  payload: `0x${string}`;
}

interface Received {
  assetId: `0x${string}`;
  price: bigint;
  timestamp: bigint;
}

/** The decoded publish's emitter, `0x`-prefixed. */
const emitterOf = (a: Publish) => `0x${a.emitter}`;

/**
 * Oracle updates: published by a relay's emitter, delivered by its receiver.
 *
 * Nothing the receiver emits names the VAA, but it does name the VAA's timestamp — which on every
 * source is the publishing block's, or on Solana what the shim stamped — so an update is keyed by
 * source, asset and that timestamp, and either end can land first. A receiver reverts an update that
 * is out of order or older than its window, so a publish that never delivers is simply one it
 * refused; the pages call it expired.
 */
export const updates: Flow = {
  name: "oracle",
  table: "oracle_updates",
  key: { column: "id", type: "TEXT" },
  states: { published: 0, delivered: 1 },
  columns: {
    source_chain: "TEXT",
    asset_id: "TEXT",
    /** The VAA's timestamp, unix seconds. */
    vaa_time: "BIGINT",
    /** 1 a price, 2 a rate. */
    action: "SMALLINT",
    /** 18 decimals, in the feed's own unit. */
    value: "NUMERIC",
    emitter: "TEXT",
    sequence: "BIGINT",
    vaa_id: "TEXT",
    dest_chain: "TEXT",
    receiver: "TEXT",
    published: "JSONB",
    delivered: "JSONB",
  },
  indexes: [
    `CREATE INDEX IF NOT EXISTS idx_oracle_updates_asset ON oracle_updates (asset_id, vaa_time DESC);`,
  ],
  legs: [
    {
      role: "wormhole-core",
      chains: EVM_SOURCES,
      abi: LogMessagePublishedEvt,
      state: "published",
      key: (a: Logged, ev: LogEvent) => published(a.sender, a.sequence, a.payload, ev)?.key ?? null,
      patch: (a: Logged, ev: LogEvent) => published(a.sender, a.sequence, a.payload, ev)!.patch,
    },
    {
      // Solana, as its watcher decodes the post.
      role: "wormhole-core",
      chains: ["solana"],
      near: PUBLISH,
      state: "published",
      key: (a: Publish, ev: LogEvent) =>
        published(emitterOf(a), BigInt(a.seq), a.data, ev, a.timestamp)?.key ?? null,
      patch: (a: Publish, ev: LogEvent) =>
        published(emitterOf(a), BigInt(a.seq), a.data, ev, a.timestamp)!.patch,
    },
    {
      role: "oracle-receiver",
      abi: PriceReceivedEvt,
      state: "delivered",
      key: (a: Received, ev: LogEvent) => {
        const source = SOURCE_OF.get(ev.address.toLowerCase());
        return source ? key(source, a.assetId, a.timestamp) : null;
      },
      patch: (a: Received, ev: LogEvent) => ({
        source_chain: SOURCE_OF.get(ev.address.toLowerCase()),
        asset_id: a.assetId.toLowerCase(),
        vaa_time: a.timestamp.toString(),
        value: a.price.toString(),
        dest_chain: ev.chain,
        receiver: ev.address.toLowerCase(),
        delivered: ev.ref,
      }),
    },
  ],
};
