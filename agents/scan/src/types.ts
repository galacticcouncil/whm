import type { AbiEvent, Chain as ViemChain } from "viem";
import type { FastifyInstance } from "fastify";

// ─── Chains ──────────────────────────────────────────────────────

export type ChainKind = "evm" | "substrate";

interface ChainBase {
  name: string;
  kind: ChainKind;
  startBlock: bigint;
  confirmations: bigint;
  concurrency: number;
}

export interface EvmChain extends ChainBase {
  kind: "evm";
  chain: ViemChain;
  rpcUrl: string;
  chunkSize: bigint;
}

export interface SubstrateChain extends ChainBase {
  kind: "substrate";
  chainId: number;
  wssUrl: string;
  checkpointEvery: number;
}

export type ChainCfg = EvmChain | SubstrateChain;

// ─── Events ──────────────────────────────────────────────────────

export interface LogRef {
  chain: string;
  blockNumber: string;
  txHash: `0x${string}`;
  logIndex: number;
}

export interface EventRef extends LogRef {
  blockTimestamp: number;
}

export interface LogEvent {
  chain: string;
  address: string;
  ref: LogRef;
  eventName: string;
  args: Record<string, unknown>;
}

/** Decodes + handles one event signature emitted by a watched contract. */
export interface EventHandler {
  abi: AbiEvent;
  handle: (ev: LogEvent) => Promise<void> | void;
}

// ─── Features ────────────────────────────────────────────────────

/** A contract watched on a named chain, plus the handlers for its events. */
export interface FeatureContract {
  /** chain name — must be present in the enabled chain registry */
  chain: string;
  address: `0x${string}`;
  /** optional getLogs topic filter (EVM only) — narrows a firehose emitter (e.g. Wormhole core → one sender) */
  topics?: (`0x${string}` | null)[];
  events: EventHandler[];
}

/**
 * A feature owns its decoding, its storage, its API surface, and its status counts.
 * The generic harness (chains → events → processor) routes decoded events to the
 * feature's handlers and otherwise knows nothing feature-specific.
 */
export interface Feature {
  name: string;
  contracts: FeatureContract[];
  /** create the feature's own tables (idempotent) */
  initSchema(): Promise<void>;
  /** register the feature's HTTP routes (convention: /api/<name>/*) */
  routes(app: FastifyInstance): void;
  /** per-state record counts for /api/status */
  counts(): Promise<Record<string, number>>;
  /** optional background worker, started after watchers (e.g. the intents settlement poller) */
  start?(): void;
}
