import { base58 } from "@scure/base";
import { pad, toEventSelector } from "viem";

import { LogMessagePublishedEvt, nearTopic } from "./abi";
import { CHAINS } from "./chains";
import { PUBLISH } from "./chains/events";
import {
  BASEJUMP,
  INTENT,
  NTT,
  nttLegs,
  UTXO,
  WORMHOLE_CORE,
  type EvmLeg,
  type SolanaLeg,
  type SuiLeg,
} from "./deployments";
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
 * 2026-09-01 00:00 UTC on each chain — a block, a slot, a checkpoint — where the public dataset
 * starts.
 *
 * Robinhood's and HyperEVM's NTT came later, so theirs is the deploy: 2026-09-05 and
 * 2026-09-29.
 *
 * Full history starts 2026-07-28: hydration 13_349_127, base 49_203_727; solana from
 * SOL's first transaction (436_017_983), sui from its deploy (305_105_552).
 */
const SEPT_1 = {
  hydration: 14_056_293n,
  ethereum: 25_878_705n,
  base: 50_715_727n,
  robinhood: 54_675_547n,
  hyperevm: 47_156_536n,
  solana: 443_282_098n,
  sui: 317_287_616n,
};

/** 2026-10-01 00:00 UTC on each chain — the smaller dataset indexing was tested on. */
const OCT_1 = {
  hydration: 15_237_663n,
  ethereum: 26_093_738n,
  base: 52_011_727n,
  robinhood: 76_928_654n,
  hyperevm: 47_332_216n,
  solana: 452_119_504n,
  sui: 328_848_249n,
};

/** Where each cursor starts, by chain, then by what it indexes. */
const FROM = {
  hydration: {
    ntt: SEPT_1.hydration,
    intents: SEPT_1.hydration,
    basejump: SEPT_1.hydration,
    /** ZecUtxoEmitter's deploy. */
    utxoZec: 15_901_846n,
  },
  ethereum: {
    ntt: SEPT_1.ethereum,
    intents: SEPT_1.ethereum,
    basejump: SEPT_1.ethereum,
  },
  base: { ntt: SEPT_1.base },
  robinhood: { ntt: SEPT_1.robinhood },
  hyperevm: { ntt: SEPT_1.hyperevm },
  solana: { ntt: SEPT_1.solana },
  sui: { ntt: SEPT_1.sui },
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
 * @param topic0 The publish's topic: the core's event on an EVM chain, the decoded one elsewhere.
 */
function published(senders: string[], topic0 = LOG_MESSAGE_PUBLISHED): Watch["topics"] {
  return [topic0, senders.map((s) => pad(s as `0x${string}`, { size: 32 }))];
}

/** The EVM chains NTT legs are indexed on. */
const NTT_EVM = ["hydration", "ethereum", "base", "robinhood", "hyperevm"] as const;

/** Every EVM leg's contracts on a chain. */
const evmLegs = (chain: string) =>
  nttLegs(chain).filter((l): l is EvmLeg => typeof l !== "string" && "transceiver" in l);

/** Every Solana leg. */
const solanaLegs = () => nttLegs("solana") as SolanaLeg[];

/** Every Sui leg. */
const suiLegs = () => nttLegs("sui") as SuiLeg[];

/** Every NEAR leg's account. */
const nearLegs = () => nttLegs("near").filter((l): l is string => typeof l === "string");

/**
 * The Wormhole cores, filtered to the emitters we own: every token's transceiver, plus the intent
 * emitter on Hydration. NEAR's, Solana's and Sui's cores are shared, so each is read through the
 * managers' own histories — and on Solana and Sui still filtered by emitter, since anything else a
 * transaction of ours publishes is not ours.
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
  {
    chain: "solana",
    role: "wormhole-core",
    from: FROM.solana.ntt,
    at: [WORMHOLE_CORE.solana],
    via: solanaLegs().map((l) => l.program),
    topics: published(
      solanaLegs().map((l) => `0x${Buffer.from(base58.decode(l.emitter)).toString("hex")}`),
      nearTopic(PUBLISH),
    ),
  },
  {
    chain: "sui",
    role: "wormhole-core",
    from: FROM.sui.ntt,
    at: [WORMHOLE_CORE.sui],
    via: suiLegs().map((l) => l.state),
    topics: published(
      suiLegs().map((l) => l.emitter),
      nearTopic(PUBLISH),
    ),
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
  {
    chain: "solana",
    role: "ntt",
    from: FROM.solana.ntt,
    at: solanaLegs().map((l) => l.program),
  },
  {
    chain: "sui",
    role: "ntt",
    from: FROM.sui.ntt,
    at: suiLegs().map((l) => l.state),
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
