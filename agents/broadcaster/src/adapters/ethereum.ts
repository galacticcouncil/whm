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

import { wallet } from "@whm/common/evm";

import log from "../logger.js";
import type { ChainAdapter, Feed } from "./types.js";

type EvmPublicClient = ReturnType<typeof wallet.getWallet>["publicClient"];

interface EthereumConfig {
  rpcUrl: string;
  chainId: number;
  privateKey: Hex;
  emitter: Address;
  fromBlock: bigint;
  symbols: string[]; // when set, assetId = keccak256(symbol) (no getLogs); else log-scan
}

interface EvmFeed extends Feed {
  assetId: Hex;
  source: Address;
  call: Hex;
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

export function createEthereumAdapter(cfg: EthereumConfig): ChainAdapter {
  const { publicClient, walletClient, account } = wallet.getWallet(
    cfg.rpcUrl,
    cfg.chainId,
    cfg.privateKey,
  );

  log.info(`  [ethereum] emitter: ${cfg.emitter} (chain ${cfg.chainId}, signer ${account.address})`);

  return {
    name: "ethereum",

    async loadFeeds() {
      // Symbols (assetId = keccak256(symbol), no getLogs) work on any RPC; the
      // FeedRegistered log-scan fallback needs an archive-capable RPC.
      const candidates: { assetId: Hex; label: string }[] =
        cfg.symbols.length > 0
          ? cfg.symbols.map((s) => ({ assetId: keccak256(toBytes(s)), label: s }))
          : (await discoverAssetIds(publicClient, cfg.emitter, cfg.fromBlock)).map((assetId) => ({
              assetId,
              label: assetId,
            }));

      const feeds: EvmFeed[] = [];
      for (const { assetId, label } of candidates) {
        const [source, call] = (await publicClient.readContract({
          address: cfg.emitter,
          abi: EMITTER_ABI,
          functionName: "feeds",
          args: [assetId],
        })) as readonly [Address, Hex];

        if (isAddressEqual(source, zeroAddress)) {
          log.info(`  [ethereum] ${label} not registered, skipping`);
          continue;
        }
        feeds.push({ key: assetId, label, assetId, source, call });
      }

      log.info(`Loaded ${feeds.length} Ethereum feeds`);
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
      const { assetId, label } = feed as EvmFeed;

      const fee = (await publicClient.readContract({
        address: cfg.emitter,
        abi: EMITTER_ABI,
        functionName: "quoteCrossChainCost",
      })) as bigint;

      const hash = await walletClient.writeContract({
        address: cfg.emitter,
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
