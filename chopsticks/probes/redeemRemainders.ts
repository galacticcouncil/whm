/**
 * Redeem the six signed MRL migration remainder VAAs into the TC Safe/Squads accounts.
 *
 * Check only (default, no keys required):
 *   pnpm tsx chopsticks/probes/redeemRemainders.ts
 *
 * Execute:
 *   EVM_KEY=0x… SOLANA_KEYPAIR=~/key.json \
 *   [ETH_RPC=… BASE_RPC=… SOLANA_RPC=…] \
 *     pnpm tsx chopsticks/probes/redeemRemainders.ts --execute
 *
 * SOLANA_KEYPAIR accepts a keypair-file path, an inline JSON byte array, or a
 * base58 secret. Set ONLY=96949 or ONLY=WBTC to limit a run. Recipient, token,
 * amount, destination, emitter, sequence, and zero relayer fee are fixed and
 * validated from the signed VAA before any transaction is submitted.
 */
import {
  Wormhole,
  deserialize,
  encoding,
  signSendWait,
  wormhole,
} from "@wormhole-foundation/sdk";
import evm from "@wormhole-foundation/sdk/evm";
import solana from "@wormhole-foundation/sdk/solana";
import { getEvmSignerForKey } from "@wormhole-foundation/sdk-evm";
import { getSolanaSignAndSendSigner } from "@wormhole-foundation/sdk-solana";
import { Keypair, PublicKey } from "@solana/web3.js";
import { existsSync, readFileSync } from "node:fs";
import { fetchVaaHexOnce } from "../../common/wormhole/scan";

const EMITTER_CHAIN = 16;
const EMITTER =
  "000000000000000000000000b1731c586ca89a23809861c6103f0b96b3f57d92";
const SAFE = "d557aeaf1e0cb3d226bff3b7a10c2cda9da081e7";

type Chain = "Ethereum" | "Base" | "Solana";
type Job = {
  seq: bigint;
  sym: string;
  chain: Chain;
  amount: bigint;
  displayAmount: string;
  token: string;
  recipient: string;
  recipientNative?: string;
};

const JOBS: Job[] = [
  {
    seq: 96949n,
    sym: "WBTC",
    chain: "Ethereum",
    amount: 936000000n,
    displayAmount: "9.36 WBTC",
    token:
      "0000000000000000000000002260fac5e5542a773aa44fbcfedf7c193bc2c599",
    recipient: SAFE.padStart(64, "0"),
  },
  {
    seq: 96950n,
    sym: "USDC",
    chain: "Ethereum",
    amount: 104351000000n,
    displayAmount: "104,351 USDC",
    token:
      "000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    recipient: SAFE.padStart(64, "0"),
  },
  {
    seq: 96951n,
    sym: "USDT",
    chain: "Ethereum",
    amount: 117234000000n,
    displayAmount: "117,234 USDT",
    token:
      "000000000000000000000000dac17f958d2ee523a2206206994597c13d831ec7",
    recipient: SAFE.padStart(64, "0"),
  },
  {
    seq: 96952n,
    sym: "PRIME",
    chain: "Solana",
    amount: 2630091000000n,
    displayAmount: "2,630,091 PRIME",
    token:
      "26759f460ee5f743ed66d27c8f2a5623bf39d53ed575955320661e6e13e0e3da",
    recipient:
      "ce2911d2bf99077bc8ac59dc15097bc76f25f67f8178298bf3412550064ba593",
    recipientNative: "EsmJrr2f9oufzJKGDeCbCgYTx6Nv7evpz24L12So2KU6",
  },
  {
    seq: 96953n,
    sym: "EURC",
    chain: "Base",
    amount: 155603000000n,
    displayAmount: "155,603 EURC",
    token:
      "00000000000000000000000060a3e35cc302bfa44cb288bc5a4f316fdb1adb42",
    recipient: SAFE.padStart(64, "0"),
  },
  {
    seq: 96954n,
    sym: "SOL",
    chain: "Solana",
    amount: 148800000000n,
    displayAmount: "1,488 SOL",
    token:
      "069b8857feab8184fb687f634618c035dac439dc1aeb3b5598a0f00000000001",
    recipient:
      "4e69fc5b9315ae4d2aeeddfc7957aec78c921a5230d7e1fa75fcf24c3630ea65",
    recipientNative: "6H6Y1zwJ8xFFmN7MxQVwnHXHFT4v41VwdhYWDiwF9s24",
  },
];

const RPC: Partial<Record<Chain, string>> = {
  Ethereum: process.env.ETH_RPC ?? process.env.ETHEREUM_RPC,
  Base: process.env.BASE_RPC,
  Solana: normalizeSolanaRpc(process.env.SOLANA_RPC),
};

const execute = process.argv.includes("--execute");
const selected = selectJobs(process.env.ONLY);

async function main() {
  console.log(`Mode: ${execute ? "EXECUTE" : "CHECK ONLY"}`);
  console.log(`Claims: ${selected.map((job) => job.sym).join(", ")}`);

  const cfg: any = { chains: {} };
  for (const [chain, rpc] of Object.entries(RPC)) {
    if (rpc) cfg.chains[chain] = { rpc };
  }
  const wh = await wormhole("Mainnet", [evm, solana], cfg);

  const pending: { job: Job; chain: any; tb: any; vaa: any }[] = [];
  for (const job of selected) {
    const hex = await fetchVaaHexOnce(
      EMITTER_CHAIN,
      EMITTER,
      job.seq,
      process.env.WORMHOLE_API_KEY,
    );
    if (!hex) throw new Error(`signed VAA ${job.seq} is not available`);

    const vaa = deserialize("TokenBridge:Transfer", encoding.hex.decode(hex));
    validateVaa(job, vaa);

    const chain = wh.getChain(job.chain);
    const tb = await chain.getTokenBridge();
    const complete = await tb.isTransferCompleted(vaa);
    console.log(
      `[${complete ? "complete" : "pending"}] ${job.sym} ${job.displayAmount} -> ${job.recipientNative ?? `0x${SAFE}`}`,
    );
    if (!complete) pending.push({ job, chain, tb, vaa });
  }

  if (!execute) {
    console.log(
      pending.length === 0
        ? "All selected claims are complete."
        : `${pending.length} claim(s) remain; rerun with --execute to submit.`,
    );
    return;
  }
  if (pending.length === 0) return;

  const evmKey = pending.some(({ job }) => job.chain !== "Solana")
    ? requireEnv("EVM_KEY")
    : undefined;
  const solanaSecret = pending.some(({ job }) => job.chain === "Solana")
    ? readSolanaSecret(requireEnv("SOLANA_KEYPAIR"))
    : undefined;

  const signerCache: Partial<Record<Chain, any>> = {};
  async function signerFor(chainName: Chain, chain: any) {
    if (signerCache[chainName]) return signerCache[chainName];
    const rpc = await chain.getRpc();
    const signer =
      chainName === "Solana"
        ? await getSolanaSignAndSendSigner(rpc, solanaSecret as any)
        : await getEvmSignerForKey(rpc, evmKey as string);
    signerCache[chainName] = signer;
    console.log(`${chainName} payer: ${signer.address()}`);
    return signer;
  }

  const failures: string[] = [];
  for (const { job, chain, tb, vaa } of pending) {
    try {
      if (await tb.isTransferCompleted(vaa)) {
        console.log(`[complete] ${job.sym} completed concurrently; skipping`);
        continue;
      }
      const signer = await signerFor(job.chain, chain);
      const sender = Wormhole.chainAddress(chain.chain, signer.address());
      // Never unwrap: SOL must land as wSOL in the Squads vault ATA.
      const txids = await signSendWait(
        chain,
        tb.redeem(sender.address, vaa, false),
        signer,
      );
      if (!(await tb.isTransferCompleted(vaa))) {
        throw new Error("destination completion flag is still false");
      }
      console.log(
        `[done] ${job.sym} on ${job.chain}: ${txids.map((tx) => tx.txid).join(", ")}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${job.sym}: ${message}`);
      console.error(`[failed] ${job.sym}: ${message}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `failed claims:\n${failures.map((f) => `- ${f}`).join("\n")}`,
    );
  }
}

function validateVaa(job: Job, vaa: any) {
  assertEqual(vaa.emitterChain, "Moonbeam", "emitter chain");
  assertEqual(normalizeHex(vaa.emitterAddress.toString()), EMITTER, "emitter");
  assertEqual(BigInt(vaa.sequence), job.seq, "sequence");
  assertEqual(vaa.payload.to.chain, job.chain, "destination chain");
  assertEqual(
    normalizeHex(vaa.payload.to.address.toString()),
    job.recipient,
    "recipient",
  );
  assertEqual(vaa.payload.token.chain, job.chain, "token chain");
  assertEqual(
    normalizeHex(vaa.payload.token.address.toString()),
    job.token,
    "token",
  );
  assertEqual(BigInt(vaa.payload.token.amount), job.amount, "amount");
  assertEqual(BigInt(vaa.payload.fee), 0n, "relayer fee");

  if (job.chain === "Solana") {
    const recipient = new PublicKey(
      Buffer.from(job.recipient, "hex"),
    ).toBase58();
    assertEqual(recipient, job.recipientNative, "native Solana recipient");
  }
}

function readSolanaSecret(value: string): string | Keypair {
  let encoded = value.trim();
  if (existsSync(encoded)) encoded = readFileSync(encoded, "utf8").trim();
  if (!encoded.startsWith("[")) return encoded;

  const bytes = Uint8Array.from(JSON.parse(encoded));
  if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
  if (bytes.length === 32) return Keypair.fromSeed(bytes);
  throw new Error(
    `SOLANA_KEYPAIR must contain 32 or 64 bytes; got ${bytes.length}`,
  );
}

function selectJobs(only?: string) {
  if (!only) return JOBS;
  const values = new Set(
    only
      .split(",")
      .map((value) => value.trim().toUpperCase())
      .filter(Boolean),
  );
  const jobs = JOBS.filter(
    (job) => values.has(job.sym) || values.has(job.seq.toString()),
  );
  if (jobs.length === 0) throw new Error(`ONLY=${only} matched no claim`);
  return jobs;
}

function normalizeSolanaRpc(value?: string) {
  if (!value) return undefined;
  if (value.startsWith("wss://")) return `https://${value.slice(6)}`;
  if (value.startsWith("ws://")) return `http://${value.slice(5)}`;
  return value;
}

function normalizeHex(value: string) {
  return value.toLowerCase().replace(/^0x/, "");
}

function requireEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required with --execute`);
  return value;
}

function assertEqual(actual: unknown, expected: unknown, field: string) {
  if (actual !== expected) {
    throw new Error(
      `${field}: got ${String(actual)}, expected ${String(expected)}`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
