import { pad, toEventSelector } from "viem";

import { LogMessagePublishedEvt } from "./abi";
import { CHAINS } from "./chains";
import type { Watch } from "./types";

/**
 * What to index, and where each cursor starts.
 *
 * A watch entry is the unit of both ingestion and backfill: adding one indexes only that contract,
 * from only its own `from`, while everything else stays at the tip. Roles are how a flow addresses
 * a contract — never by address, so a redeployment or a second deployment of the same role is a
 * change here and nowhere else.
 *
 * Only the corridors actually running are listed. NTT has eleven tokens deployed; the rest go in
 * when something reads them.
 */

// ─── Hydration ───────────────────────────────────────────────────

/** 2026-08-25 00:00 UTC */
const FROM_HYDRATION = 13_775_946n;

const WORMHOLE_CORE_HYDRATION = "0x3792a6d63c31941B2805181771795D9176fA82A1";

export const WETH_TRANSCEIVER_HYDRATION = "0x8acce9CA511d5D7213F8C3f813B8916087cd00ae";
export const WETH_MANAGER_HYDRATION = "0xb5cef790d52a57fa619ed96edd64c5328f3dcfb7";

/**
 * Its Wormhole messages are the forwarding instructions, and its emitter sequence counts intents
 * alone, from zero — unlike the NTT manager's, which every corridor riding that token shares.
 */
export const INTENT_EMITTER = "0x98f1ebC9dcC8Ab7bA54D83C98500e9e313F793f2";

const INTENT_QUOTE_EMITTER: `0x${string}`[] = [];

/** Basejump landing. Several independent deployments merge into one view, so this is a list. */
const BASEJUMP_LANDING = ["0x70e9b12c3b19cb5f0e59984a5866278ab69df976"];

/**
 * The NEAR hub's corridors: NEAR and ZEC, each a BURNING manager on Hydration paired with a LOCKING
 * one on NEAR. Their own entries, from the earlier of the two deploys, so they backfill without
 * pulling WETH's cursors back.
 */
const FROM_NEAR_NTT_HYDRATION = 15_644_771n;

export const NEAR_TRANSCEIVER_HYDRATION = "0xc74BcE0b4bC1b06D6e31d8EfAf55e7e148f281d1";
export const NEAR_MANAGER_HYDRATION = "0x374E5239a2342Be6Bf31B410EC03984D03A8b7dE";
export const ZEC_TRANSCEIVER_HYDRATION = "0x0dd43A80C6F96019B8f5699Df1890DFa33BdDE85";
export const ZEC_MANAGER_HYDRATION = "0xe20cED5f5798cD4FeBc7aE182309b9f51345e0cC";

/** ZecUtxoEmitter — a withdrawal's Zcash destination and the NEAR account it goes through. */
export const ZEC_UTXO_EMITTER = "0xb3e365a6241683d5d4ef2701de6bedc16dcc259e";
const FROM_ZEC_UTXO_EMITTER = 15_901_846n;

// ─── Ethereum ────────────────────────────────────────────────────

/** 2026-08-25 00:00 UTC */
const FROM_ETHEREUM = 25_828_484n;

const WORMHOLE_CORE_ETHEREUM = "0x98f3c9e6E3fAce36bAAd05FE09d375Ef1464288B";

export const WETH_TRANSCEIVER_ETHEREUM = "0xbA0Cd32131b8206AF4feB79A1A3aaF0AEfe18b48";
export const WETH_MANAGER_ETHEREUM = "0x283B14B5Dd352e32154Df014EA96834F395E04b6";

const INTENT_RECEIVER = "0x2173F6ecE25768e7EFc5199f70f8783d88Ba63c8";

/** BasejumpEmitter on Ethereum — the corridor is moving here, and is not deployed yet. */
const BASEJUMP_EMITTER: `0x${string}`[] = [];

// ─── NEAR ────────────────────────────────────────────────────────

/** ntt-near's deploy block, the earlier of the two managers. */
const FROM_NEAR = 219_438_351n;

export const NTT_ZEC_NEAR = "ntt-zec.hydration-whm.near";
export const NTT_NEAR_NEAR = "ntt-near.hydration-whm.near";

/** NEAR's Wormhole core. Shared, so it is read through our managers' histories. */
const WORMHOLE_CORE_NEAR = "contract.wormhole_crypto.near";

/** Omni's Zcash connector. A deposit is proven, minted and handed to `ntt-zec` in one transaction. */
export const ZCASH_CONNECTOR = "zcash-connector.bridge.near";

// ─────────────────────────────────────────────────────────────────

const LOG_MESSAGE_PUBLISHED = toEventSelector(LogMessagePublishedEvt);

/**
 * A Wormhole core filter admitting only our own emitters. Without it the core is every protocol on
 * the chain, which on Ethereum is thousands of messages a day.
 *
 * @param senders Emitter addresses to keep.
 */
function published(senders: `0x${string}`[]): Watch["topics"] {
  return [LOG_MESSAGE_PUBLISHED, senders.map((s) => pad(s, { size: 32 }))];
}

export const WATCH: Watch[] = [
  {
    chain: "hydration",
    role: "wormhole-core",
    from: FROM_HYDRATION,
    at: [WORMHOLE_CORE_HYDRATION],
    topics: published([WETH_TRANSCEIVER_HYDRATION, INTENT_EMITTER, ...INTENT_QUOTE_EMITTER]),
  },
  {
    // Manager and transceiver share one entry deliberately: a delivery emits `ReceivedMessage` on
    // the transceiver and `TransferRedeemed` on the manager in the same transaction, and only the
    // first names the VAA the second's digest belongs to. One entry means one getLogs, so they are
    // stored — and drained — in log order. Split them and the manager's leg finds no row.
    chain: "hydration",
    role: "ntt",
    from: FROM_HYDRATION,
    at: [WETH_TRANSCEIVER_HYDRATION, WETH_MANAGER_HYDRATION],
  },
  {
    chain: "hydration",
    role: "wormhole-core",
    id: "wormhole-core:near-ntt",
    from: FROM_NEAR_NTT_HYDRATION,
    at: [WORMHOLE_CORE_HYDRATION],
    topics: published([NEAR_TRANSCEIVER_HYDRATION, ZEC_TRANSCEIVER_HYDRATION]),
  },
  {
    // One entry for both pairs, for the same reason as WETH's.
    chain: "hydration",
    role: "ntt",
    id: "ntt:near-ntt",
    from: FROM_NEAR_NTT_HYDRATION,
    at: [
      NEAR_TRANSCEIVER_HYDRATION,
      NEAR_MANAGER_HYDRATION,
      ZEC_TRANSCEIVER_HYDRATION,
      ZEC_MANAGER_HYDRATION,
    ],
  },
  {
    chain: "hydration",
    role: "utxo-emitter",
    from: FROM_ZEC_UTXO_EMITTER,
    at: [ZEC_UTXO_EMITTER],
  },
  {
    chain: "hydration",
    role: "intent-emitter",
    from: FROM_HYDRATION,
    at: [INTENT_EMITTER],
  },
  {
    chain: "hydration",
    role: "intent-quote",
    from: FROM_HYDRATION,
    at: INTENT_QUOTE_EMITTER,
  },
  {
    chain: "ethereum",
    role: "wormhole-core",
    from: FROM_ETHEREUM,
    at: [WORMHOLE_CORE_ETHEREUM],
    topics: published([WETH_TRANSCEIVER_ETHEREUM]),
  },
  {
    chain: "ethereum",
    role: "ntt",
    from: FROM_ETHEREUM,
    at: [WETH_TRANSCEIVER_ETHEREUM, WETH_MANAGER_ETHEREUM],
  },
  {
    chain: "ethereum",
    role: "intent-receiver",
    from: FROM_ETHEREUM,
    at: [INTENT_RECEIVER],
  },
  {
    // BridgeInitiated names no sender, and who bridged is the first thing anyone asks.
    chain: "ethereum",
    role: "basejump-source",
    from: FROM_ETHEREUM,
    at: BASEJUMP_EMITTER,
    sender: true,
  },
  {
    chain: "hydration",
    role: "basejump-landing",
    from: FROM_HYDRATION,
    at: BASEJUMP_LANDING,
  },
  {
    chain: "near",
    role: "wormhole-core",
    from: FROM_NEAR,
    at: [WORMHOLE_CORE_NEAR],
    via: [NTT_NEAR_NEAR, NTT_ZEC_NEAR],
  },
  {
    chain: "near",
    role: "ntt",
    from: FROM_NEAR,
    at: [NTT_NEAR_NEAR, NTT_ZEC_NEAR],
  },
  {
    // The proof's arguments name what no log does: the Zcash transaction itself — and so who paid
    // — and the order, refund address included.
    chain: "near",
    role: "utxo-connector",
    from: FROM_NEAR,
    at: [ZCASH_CONNECTOR],
    via: [NTT_ZEC_NEAR],
    calls: ["verify_deposit_v2"],
  },
].filter((w) => w.at.length > 0) as Watch[];

/** The watch entries on chains this process has an endpoint for. */
export const enabled: Watch[] = WATCH.filter((w) => CHAINS[w.chain]);
