import {
  decodeAbiParameters,
  isAddressEqual,
  keccak256,
  parseEventLogs,
  toBytes,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";

import type { wallet } from "@whm/common/evm";

import type { Broadcaster, Feed } from "../types.js";
import log from "../logger.js";

export type EvmWallet = ReturnType<typeof wallet.getWallet>;
type EvmPublicClient = EvmWallet["publicClient"];

export interface EmitterRoute {
  /** Namespaces this route's feeds in state, and prefixes them in logs. */
  label: string;
  /** OracleEmitter proxy. */
  emitter: Address;
  /** What to publish: assetId = keccak256(symbol), which needs no log scan. */
  symbols: string[];
  /** FeedRegistered scan floor, used only when `symbols` is empty. Needs an archive RPC. */
  fromBlock: bigint;
}

export interface EvmFeed extends Feed {
  emitter: Address;
  assetId: Hex;
  source: Address;
  call: Hex;
}

export interface EvmBroadcasterOptions {
  /** App name — the state file and the startup line. */
  name: string;
  /** Wallet on the chain the emitters live on. */
  wallet: EvmWallet;
  routes: EmitterRoute[];
}

const LOG_CHUNK = 10_000n; // eth_getLogs block window — public RPCs reject wide ranges

// OracleEmitter — minimal surface (contracts/src/oracles/OracleEmitter.sol)
const EMITTER_ABI = [
  {
    type: "function",
    name: "feeds",
    stateMutability: "view",
    inputs: [{ name: "assetId", type: "bytes32" }],
    outputs: [
      { name: "source", type: "address" },
      { name: "call", type: "bytes" },
    ],
  },
  {
    type: "function",
    name: "quoteCrossChainCost",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "send",
    stateMutability: "payable",
    inputs: [{ name: "assetId", type: "bytes32" }],
    outputs: [{ type: "uint64" }],
  },
  {
    type: "event",
    name: "FeedRegistered",
    inputs: [
      { name: "assetId", type: "bytes32", indexed: true },
      { name: "source", type: "address", indexed: false },
    ],
  },
  {
    type: "event",
    name: "RatePublished",
    inputs: [
      { name: "assetId", type: "bytes32", indexed: true },
      { name: "rate", type: "uint256", indexed: false },
      { name: "sequence", type: "uint64", indexed: false },
    ],
  },
] as const;

// Mirror of the Solana program.account.*.all() discovery: collect candidate
// assetIds from FeedRegistered logs, then let feeds() be the source of truth.
async function discoverAssetIds(
  client: EvmPublicClient,
  emitter: Address,
  fromBlock: bigint,
): Promise<Hex[]> {
  const latest = await client.getBlockNumber();
  const seen = new Set<Hex>();

  for (let from = fromBlock; from <= latest; from += LOG_CHUNK) {
    const to = from + LOG_CHUNK - 1n > latest ? latest : from + LOG_CHUNK - 1n;
    const events = await client.getContractEvents({
      address: emitter,
      abi: EMITTER_ABI,
      eventName: "FeedRegistered",
      fromBlock: from,
      toBlock: to,
    });
    for (const e of events) {
      if (e.args.assetId) seen.add(e.args.assetId);
    }
  }

  return [...seen];
}

/**
 * Build the broadcaster for OracleEmitter deployments on one EVM chain.
 *
 * @param opts App name, the chain's wallet and the routes to publish.
 * @returns The broadcaster.
 */
export function createEvmBroadcaster(opts: EvmBroadcasterOptions): Broadcaster {
  const { name, routes } = opts;
  const { publicClient, walletClient, account } = opts.wallet;
  const chainId = publicClient.chain?.id;

  for (const route of routes) {
    log.info(`  [${route.label}] emitter: ${route.emitter} (chain ${chainId})`);
  }
  log.info(`  signer: ${account.address}`);

  /** Resolve one route's registered feeds. Symbols work on any RPC; the scan needs an archive. */
  async function routeFeeds(route: EmitterRoute): Promise<EvmFeed[]> {
    const candidates: { assetId: Hex; label: string }[] =
      route.symbols.length > 0
        ? route.symbols.map((s) => ({ assetId: keccak256(toBytes(s)), label: s }))
        : (await discoverAssetIds(publicClient, route.emitter, route.fromBlock)).map((assetId) => ({
            assetId,
            label: assetId,
          }));

    const feeds: EvmFeed[] = [];
    for (const { assetId, label } of candidates) {
      const [source, call] = (await publicClient.readContract({
        address: route.emitter,
        abi: EMITTER_ABI,
        functionName: "feeds",
        args: [assetId],
      })) as readonly [Address, Hex];

      if (isAddressEqual(source, zeroAddress)) {
        log.info(`  [${route.label}] ${label} not registered, skipping`);
        continue;
      }

      feeds.push({
        key: `${route.label}:${assetId}`,
        asset: assetId,
        label: `${route.label}:${label}`,
        emitter: route.emitter,
        assetId,
        source,
        call,
      });
    }
    return feeds;
  }

  return {
    name,

    async loadFeeds() {
      const feeds: EvmFeed[] = [];
      for (const route of routes) {
        // Isolate routes: one emitter's startup failure must not take down the others.
        try {
          feeds.push(...(await routeFeeds(route)));
        } catch (err) {
          log.error(`  [${route.label}] loadFeeds failed:`, err);
        }
      }
      log.info(`Loaded ${feeds.length} feeds (chain ${chainId})`);
      return feeds;
    },

    // Mirror the contract's _readSource: staticcall(source, call) -> uint256.
    async read(feed) {
      const { source, call, label } = feed as EvmFeed;
      const { data } = await publicClient.call({ to: source, data: call });
      if (!data || data === "0x") throw new Error(`Empty source return for ${label}`);
      const [value] = decodeAbiParameters([{ type: "uint256" }], data);
      return value;
    },

    async send(feed) {
      const { emitter, assetId, label } = feed as EvmFeed;

      const fee = (await publicClient.readContract({
        address: emitter,
        abi: EMITTER_ABI,
        functionName: "quoteCrossChainCost",
      })) as bigint;

      const hash = await walletClient.writeContract({
        address: emitter,
        abi: EMITTER_ABI,
        functionName: "send",
        args: [assetId],
        value: fee,
      });

      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status === "reverted") throw new Error(`send ${label} reverted (tx ${hash})`);

      const [published] = parseEventLogs({
        abi: EMITTER_ABI,
        eventName: "RatePublished",
        logs: receipt.logs,
      });
      if (published) {
        const { rate, sequence } = published.args;
        log.info(`  send ${label} rate=${rate} seq=${sequence} tx: ${hash}`);
      } else {
        log.info(`  send ${label} tx: ${hash}`);
      }
      return hash;
    },
  };
}
