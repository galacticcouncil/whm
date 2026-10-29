import { randomBytes } from "node:crypto";

import { JsonRpcProvider } from "near-api-js";

import { view, type TxOutcome } from "@whm/common/near";

import { decodeBase58 } from "../utxo-withdraw/shared";

/** POA bridge RPC — `deposit_address`. */
export const POA_RPC = "https://bridge.chaindefuser.com/rpc";

/** 1Click Swap API. The partner key comes from the ONECLICK_KEY environment variable. */
export const ONECLICK_API = "https://1click.chaindefuser.com";

/** Solver relay — `publish_intent`, `get_status`. */
export const RELAY_RPC = "https://solver-relay-v2.chaindefuser.com/rpc";

/** What `get_config` returns. */
export interface Config {
  mpc_signer: string;
  intents: string;
  core: string;
  emitter_chain: number;
  emitter: string;
  eth_token: string;
  quote_keys: string[];
  params: {
    price_validity: number;
    max_quote_age: number;
    transfer_validity: number;
    max_fill_multiple: number;
    max_order_shortfall_bps: number;
    min_refund: string;
  };
}

/** The terms, as the router's `terms.rs` reads them. */
export interface Terms {
  quoteId: Buffer;
  maxSlippageBps: number;
  /** Destination units per 1e18 wei; 0 = no hard floor. */
  minOutPerIn: bigint;
  /**
   * Before the deadline, deliver only once `A` holds this much of the destination — at least POA's
   * `min_withdrawal_amount` for the token (`supported_tokens`); above it, a batch size.
   */
  minDelivery: bigint;
  /** Unix seconds. */
  deadline: bigint;
  /** 0 = withdraw off NEAR, 1 = intents account. */
  recipientKind: 0 | 1;
  /** Ethereum address. */
  refundTo: string;
  destinationAsset: string;
  recipient: string;
}

/**
 * Packs terms big-endian, version 2 (limit swap) — byte for byte what the router parses.
 *
 * @param t The terms
 * @returns The encoded terms
 */
export function encodeTerms(t: Terms): Buffer {
  const u = (n: bigint, bytes: number) => Buffer.from(n.toString(16).padStart(bytes * 2, "0"), "hex");
  const str = (s: string) => {
    const b = Buffer.from(s, "utf8");
    if (b.length < 1 || b.length > 255) throw new Error(`string of ${b.length} bytes`);
    return Buffer.concat([Buffer.from([b.length]), b]);
  };
  if (t.quoteId.length !== 32) throw new Error("quoteId must be 32 bytes");
  return Buffer.concat([
    Buffer.from([2]),
    t.quoteId,
    u(BigInt(t.maxSlippageBps), 2),
    u(t.minOutPerIn, 16),
    u(t.minDelivery, 16),
    u(t.deadline, 8),
    Buffer.from([t.recipientKind]),
    Buffer.from(t.refundTo.replace(/^0x/, ""), "hex"),
    str(t.destinationAsset),
    str(t.recipient),
  ]);
}

/** A fresh random `quoteId` — one per action. */
export const newQuoteId = (): Buffer => randomBytes(32);

/** An action's account: the derivation path, `A`'s key and id, and POA's ETH deposit address. */
export interface Derived {
  path: string;
  publicKey: string;
  account: string;
  depositAddress: string;
}

/**
 * Derives the account for `terms` exactly as the router does — its `path_of`, then
 * `derived_public_key` with the router as predecessor and domain 1 — and asks POA for the ETH
 * deposit address that credits it.
 *
 * @param provider A NEAR provider
 * @param contract The router
 * @param terms The encoded terms
 * @returns Path, key, implicit account and `0xN`
 */
export async function derive(provider: JsonRpcProvider, contract: string, terms: Buffer): Promise<Derived> {
  const config = await view<Config>(provider, contract, "get_config");
  const path = await view<string>(provider, contract, "path_of", { terms: terms.toString("base64") });
  const publicKey = await view<string>(provider, config.mpc_signer, "derived_public_key", {
    path,
    predecessor: contract,
    domain_id: 1,
  });
  const account = Buffer.from(decodeBase58(publicKey.replace(/^ed25519:/, ""))).toString("hex");
  const poa = await jsonRpc<{ address: string }>(POA_RPC, "deposit_address", { account_id: account, chain: "eth:1" });
  return { path, publicKey, account, depositAddress: poa.address };
}

/**
 * `A`'s balances on `intents.near`.
 *
 * @param provider A NEAR provider
 * @param intents The verifier
 * @param account `A`
 * @param tokens Ledger ids
 * @returns Balances by ledger id
 */
export async function balances(provider: JsonRpcProvider, intents: string, account: string, tokens: string[]): Promise<Record<string, bigint>> {
  const r = await view<string[]>(provider, intents, "mt_batch_balance_of", { account_id: account, token_ids: tokens });
  return Object.fromEntries(tokens.map((t, i) => [t, BigInt(r[i])]));
}

/** An order VAA's header and payload, unverified — what the bot needs to size a fill. */
export interface OrderVaa {
  timestamp: number;
  emitterChain: number;
  emitter: string;
  authPath: string;
  seq: bigint;
  amount: bigint;
  outPerIn: bigint;
}

/**
 * Reads an order VAA — the envelope, then `msgType 1 | authPath | seq | amount | outPerIn`.
 *
 * @param vaa The VAA bytes
 * @returns Its fields
 */
export function parseOrderVaa(vaa: Buffer): OrderVaa {
  const body = 6 + vaa[5] * 66;
  const payload = vaa.subarray(body + 51);
  if (payload.length !== 73 || payload[0] !== 1) throw new Error("not an order message");
  return {
    timestamp: vaa.readUInt32BE(body),
    emitterChain: vaa.readUInt16BE(body + 8),
    emitter: vaa.subarray(body + 10, body + 42).toString("hex"),
    authPath: `0x${payload.subarray(1, 33).toString("hex")}`,
    seq: payload.readBigUInt64BE(33),
    amount: BigInt(`0x${payload.subarray(41, 57).toString("hex")}`),
    outPerIn: BigInt(`0x${payload.subarray(57, 73).toString("hex")}`),
  };
}

/**
 * `--name <hex | base64>` → bytes.
 *
 * @param value The argument
 * @returns Its bytes
 */
export const bytesArg = (value: string): Buffer =>
  /^(0x)?[0-9a-fA-F]+$/.test(value) ? Buffer.from(value.replace(/^0x/, ""), "hex") : Buffer.from(value, "base64");

/**
 * The `signed_data` of the router's `intent_signed` event.
 *
 * @param outcome The call's outcome
 * @returns The event's data — `signed_data` is the MultiPayload
 */
export function intentSigned(outcome: TxOutcome, events: (o: TxOutcome, s: string) => { event: string; data: unknown }[]) {
  const e = events(outcome, "whm-intent-router").find((x) => x.event === "intent_signed");
  if (!e) throw new Error("no intent_signed event — see the failed receipts above");
  return (e.data as Record<string, unknown>[])[0];
}

/**
 * A JSON-RPC call — POA's bridge or the solver relay.
 *
 * @param url The endpoint
 * @param method Its method
 * @param params Its single params object
 * @returns The result; throws on an RPC error
 */
export async function jsonRpc<T>(url: string, method: string, params: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [params] }),
  });
  const body = (await res.json()) as { result?: T; error?: unknown };
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result as T;
}

/**
 * A 1Click call with the partner key.
 *
 * @param path The endpoint, with any query
 * @param body A JSON body to POST; none = GET
 * @returns The JSON response; throws on a non-2xx
 */
export async function oneClick<T>(path: string, body?: unknown): Promise<T> {
  const key = process.env.ONECLICK_KEY;
  if (!key) throw new Error("export ONECLICK_KEY (the 1Click partner key) first");
  const res = await fetch(`${ONECLICK_API}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "x-api-key": key },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${text.slice(0, 400)}`);
  return JSON.parse(text) as T;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
