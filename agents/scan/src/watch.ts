import { pad, toEventSelector } from "viem";

import { LogMessagePublishedEvt } from "./abi";
import { CHAINS } from "./chains";
import { BASEJUMP, INTENT, NTT, nttLegs, UTXO, WORMHOLE_CORE, type EvmLeg } from "./deployments";
import type { Watch } from "./types";

/**
 * What to index, and where each cursor starts. Addresses come from deployments.ts.
 *
 * A watch entry is the unit of both ingestion and backfill: adding one indexes only that contract,
 * from only its own `from`, while everything else stays at the tip. Roles are how a flow addresses
 * a contract — never by address, so a redeployment or a second deployment of the same role is a
 * change here and nowhere else.
 */

/**
 * 2026-10-01 00:00 UTC on each EVM chain — where indexing starts while testing. Full history starts
 * 2026-07-28: hydration 13_349_127, base 49_203_727; robinhood from 2026-09-05 (54_675_547),
 * hyperevm from 2026-09-29 (47_156_536).
 */
const OCT_1 = {
  hydration: 15_237_663n,
  ethereum: 26_093_738n,
  base: 52_011_727n,
  robinhood: 76_928_654n,
  hyperevm: 47_332_216n,
};

/** Where each cursor starts, by chain, then by what it indexes. */
const FROM = {
  hydration: {
    ntt: OCT_1.hydration,
    intents: OCT_1.hydration,
    basejump: OCT_1.hydration,
    /** ZecUtxoEmitter's deploy. */
    utxoZec: 15_901_846n,
  },
  ethereum: {
    ntt: OCT_1.ethereum,
    intents: OCT_1.ethereum,
    basejump: OCT_1.ethereum,
  },
  base: { ntt: OCT_1.base },
  robinhood: { ntt: OCT_1.robinhood },
  hyperevm: { ntt: OCT_1.hyperevm },
  near: {
    /** ntt-near's deploy, the earlier of the two NEAR managers. */
    ntt: 219_438_351n,
    /** withdraw-zec's deploy. */
    utxoZec: 220_248_232n,
  },
};

const LOG_MESSAGE_PUBLISHED = toEventSelector(LogMessagePublishedEvt);

/**
 * A Wormhole core filter admitting only our own emitters. Without it the core is every protocol on
 * the chain, which on Ethereum is thousands of messages a day.
 *
 * @param senders Emitter addresses to keep.
 */
function published(senders: string[]): Watch["topics"] {
  return [LOG_MESSAGE_PUBLISHED, senders.map((s) => pad(s as `0x${string}`, { size: 32 }))];
}

/** The EVM chains NTT legs are indexed on. Solana and Sui are not yet. */
const NTT_EVM = ["hydration", "ethereum", "base", "robinhood", "hyperevm"] as const;

/** Every EVM leg's contracts on a chain. */
const evmLegs = (chain: string) => nttLegs(chain).filter((l): l is EvmLeg => typeof l !== "string");

/** Every NEAR leg's account. */
const nearLegs = () => nttLegs("near").filter((l): l is string => typeof l === "string");

/**
 * The Wormhole cores, filtered to the emitters we own: every token's transceiver, plus the intent
 * emitter on Hydration. NEAR's core is shared, so it is read through the managers' histories.
 */
const WORMHOLE: Watch[] = [
  ...NTT_EVM.map((chain) => ({
    chain,
    role: "wormhole-core",
    from: FROM[chain].ntt,
    at: [WORMHOLE_CORE[chain]],
    topics: published([
      ...evmLegs(chain).map((l) => l.transceiver),
      ...(chain === "hydration" ? [INTENT.emitter] : []),
    ]),
  })),
  {
    chain: "near",
    role: "wormhole-core",
    from: FROM.near.ntt,
    at: [WORMHOLE_CORE.near],
    via: nearLegs(),
  },
];

/**
 * Every token's NTT legs, one entry per chain.
 *
 * Managers and transceivers share an entry deliberately: a delivery emits `ReceivedMessage` on the
 * transceiver and `TransferRedeemed` on the manager in the same transaction, and only the first
 * names the VAA the second's digest belongs to. One entry means one getLogs, so they are stored —
 * and drained — in log order. Split them and the manager's leg finds no row.
 */
const NTT_LEGS: Watch[] = [
  ...NTT_EVM.map((chain) => ({
    chain,
    role: "ntt",
    from: FROM[chain].ntt,
    at: evmLegs(chain).flatMap((l) => [l.transceiver, l.manager]),
  })),
  {
    chain: "near",
    role: "ntt",
    from: FROM.near.ntt,
    at: nearLegs(),
  },
];

/** Intents: placed on Hydration, forwarded on Ethereum. */
const INTENTS: Watch[] = [
  {
    chain: "hydration",
    role: "intent-emitter",
    from: FROM.hydration.intents,
    at: [INTENT.emitter],
  },
  {
    chain: "ethereum",
    role: "intent-receiver",
    from: FROM.ethereum.intents,
    at: [INTENT.receiver],
  },
];

/** Basejump: the Ethereum source, paid out of the Hydration landing pool. */
const BASEJUMPS: Watch[] = [
  {
    // BridgeInitiated names no sender, and who bridged is the first thing anyone asks.
    chain: "ethereum",
    role: "basejump-source",
    from: FROM.ethereum.basejump,
    at: [...BASEJUMP.emitter],
    sender: true,
  },
  {
    chain: "hydration",
    role: "basejump-landing",
    from: FROM.hydration.basejump,
    at: [...BASEJUMP.landing],
  },
];

/**
 * ZEC through Omni: the Hydration emitter a withdrawal leaves by, `withdraw-zec` signing it on NEAR,
 * and the NEAR connector a deposit is proven on — read through `ntt-zec`, which every deposit pays.
 */
const UTXO_ZEC: Watch[] = [
  {
    chain: "hydration",
    role: "utxo-emitter",
    from: FROM.hydration.utxoZec,
    at: [UTXO.zec.emitter],
  },
  {
    chain: "near",
    role: "utxo-withdraw",
    from: FROM.near.utxoZec,
    at: [UTXO.zec.withdraw],
  },
  {
    // The proof's arguments name what no log does: the Zcash transaction itself — and so who paid
    // — and the order, refund address included.
    chain: "near",
    role: "utxo-connector",
    from: FROM.near.ntt,
    at: [UTXO.zec.connector],
    via: [NTT.zec.near],
    calls: ["verify_deposit_v2"],
  },
];

export const WATCH: Watch[] = [
  ...WORMHOLE,
  ...NTT_LEGS,
  ...INTENTS,
  ...BASEJUMPS,
  ...UTXO_ZEC,
].filter((w) => w.at.length > 0);

/** The watch entries on chains this process has an endpoint for. */
export const enabled: Watch[] = WATCH.filter((w) => CHAINS[w.chain]);
