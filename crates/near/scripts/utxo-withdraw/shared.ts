import {
  actions,
  baseEncode,
  buildDelegateAction,
  JsonRpcProvider,
  KeyType,
  PublicKey,
  Signature,
  type SignedDelegate,
} from "near-api-js";

import { view, type TxOutcome } from "@whm/common/near";

/** What `get_params` returns. */
export interface Params {
  mpc_signer: string;
  token: string;
  connector: string;
  validity: number;
  withdraw_tgas: number;
}

/** A withdraw account: the derivation path, the key and the implicit account id. */
export interface Derived {
  path: string;
  publicKey: string;
  account: string;
}

/**
 * Derives the withdraw account for `address` exactly as the contract does: its `path_of`, then
 * `derived_public_key` on the MPC signer with the contract as predecessor and domain 1.
 *
 * @param provider A NEAR provider
 * @param contract The utxo-withdraw contract
 * @param address The destination address — the terms
 * @returns Path, `ed25519:` key and implicit account id
 */
export async function derive(provider: JsonRpcProvider, contract: string, address: string): Promise<Derived> {
  const params = await view<Params>(provider, contract, "get_params");
  const path = await view<string>(provider, contract, "path_of", { address });
  const publicKey = await view<string>(provider, params.mpc_signer, "derived_public_key", {
    path,
    predecessor: contract,
    domain_id: 1,
  });
  const account = Buffer.from(decodeBase58(publicKey.replace(/^ed25519:/, ""))).toString("hex");
  return { path, publicKey, account };
}

/**
 * Gas burnt per receipt, and what failed — for sizing the contract's static gas.
 *
 * @param label What the transaction was
 * @param outcome Its final execution outcome
 */
export function gasReport(label: string, outcome: TxOutcome): void {
  const tx = outcome.transaction_outcome.outcome.gas_burnt;
  const receipts = outcome.receipts_outcome.map((r) => ({
    executor: r.outcome.executor_id,
    tgas: Number(r.outcome.gas_burnt) / 1e12,
    failure: typeof r.outcome.status === "object" && "Failure" in r.outcome.status ? r.outcome.status.Failure : null,
  }));
  const total = Number(tx) / 1e12 + receipts.reduce((s, r) => s + r.tgas, 0);
  console.log(`${label}: tx ${outcome.transaction.hash}, ${total.toFixed(1)} TGas burnt`);
  for (const r of receipts) {
    console.log(`  ${r.tgas.toFixed(2).padStart(7)} TGas  ${r.executor}${r.failure ? `  ✗ ${JSON.stringify(r.failure)}` : ""}`);
  }
}

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * Base58 (Bitcoin alphabet) to bytes.
 *
 * @param text Base58 text
 * @returns The decoded bytes
 */
export function decodeBase58(text: string): Uint8Array {
  let n = 0n;
  for (const c of text) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error(`not base58: ${text}`);
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const c of text) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

/**
 * Decodes the contract's borsh `SignedDelegateAction` — one function call — into near-api-js types.
 *
 * @param bytes The emitted `signed_delegate`
 * @returns The equivalent `SignedDelegate`
 */
export function rebuild(bytes: Buffer): SignedDelegate {
  let at = 0;
  const u32 = () => {
    const v = bytes.readUInt32LE(at);
    at += 4;
    return v;
  };
  const u64 = () => {
    const v = bytes.readBigUInt64LE(at);
    at += 8;
    return v;
  };
  const u128 = () => {
    const lo = bytes.readBigUInt64LE(at);
    const hi = bytes.readBigUInt64LE(at + 8);
    at += 16;
    return (hi << 64n) | lo;
  };
  const raw = (n: number) => {
    const v = bytes.subarray(at, at + n);
    at += n;
    return v;
  };
  const str = () => raw(u32()).toString("utf8");

  const senderId = str();
  const receiverId = str();
  if (u32() !== 1) throw new Error("expected one action");
  if (raw(1)[0] !== 2) throw new Error("expected a FunctionCall");
  const methodName = str();
  const callArgs = Uint8Array.from(raw(u32()));
  const gas = u64();
  const deposit = u128();
  const nonce = u64();
  const maxBlockHeight = u64();
  if (raw(1)[0] !== 0) throw new Error("expected an ED25519 key");
  const publicKey = PublicKey.fromString(`ed25519:${baseEncode(raw(32))}`);
  if (raw(1)[0] !== 0) throw new Error("expected an ED25519 signature");
  const signature = Uint8Array.from(raw(64));
  if (at !== bytes.length) throw new Error("trailing bytes");

  const delegateAction = buildDelegateAction({
    actions: [actions.functionCall(methodName, callArgs, gas, deposit)],
    maxBlockHeight,
    nonce,
    publicKey,
    receiverId,
    senderId,
  });
  // `SignedDelegate` is a type only at runtime; the encoders take the plain shape.
  return { delegateAction, signature: new Signature({ keyType: KeyType.ED25519, data: signature }) };
}

/** The connector's `get_config()` fields the coin pick needs. */
interface ConnectorConfig {
  withdraw_bridge_fee: { fee_min: string; fee_rate: number };
  min_change_amount: string;
  min_withdraw_amount: string;
}

/** Zcash: one input, two outputs — ZIP-317 is always 2 × 5,000 zat. */
const FEE = 10_000n;

/**
 * Best fit over the connector's whole coin set: the smallest coin that pays `A`'s withdrawal
 * exactly or leaves change of at least `min_change_amount` — the contract's arithmetic, off-chain.
 * Below the minimum there is nothing to fit, and any coin is returned so the contract can refuse it
 * itself.
 *
 * @param provider A NEAR provider
 * @param params The contract's `get_params`
 * @param account The withdraw account `A`
 * @returns The coin as `txid:vout`
 */
export async function pickCoin(provider: JsonRpcProvider, params: Params, account: string): Promise<string> {
  const config = await view<ConnectorConfig>(provider, params.connector, "get_config");
  const balance = BigInt(await view<string>(provider, params.token, "ft_balance_of", { account_id: account }));

  const coins: [string, bigint][] = [];
  for (let from = 0; ; from += 20) {
    const page = await view<Record<string, { balance: string }>>(provider, params.connector, "get_utxos_paged", {
      from_index: from,
      limit: 20,
    });
    const entries = Object.entries(page);
    coins.push(...entries.map(([key, coin]): [string, bigint] => [key, BigInt(coin.balance)]));
    if (entries.length < 20) break;
  }
  if (coins.length === 0) throw new Error(`${params.connector} holds no coins`);
  const id = (key: string) => key.replace("@", ":");

  if (balance < BigInt(config.min_withdraw_amount)) return id(coins[0][0]);

  const { fee_min, fee_rate } = config.withdraw_bridge_fee;
  const bridgeFee = [(balance * BigInt(fee_rate)) / 10_000n, BigInt(fee_min)].reduce((a, b) => (a > b ? a : b));
  const userOut = balance - bridgeFee - FEE;
  if (userOut <= 0n) throw new Error(`balance ${balance} does not cover the fees`);
  // The coin pays the user output and the miner fee; the bridge fee stays as nzcash with Omni.
  const need = userOut + FEE;
  const minChange = BigInt(config.min_change_amount);
  const fitting = coins
    .filter(([, value]) => value === need || value >= need + minChange)
    .sort(([ka, a], [kb, b]) => (a === b ? ka.localeCompare(kb) : a < b ? -1 : 1));
  if (fitting.length === 0) throw new Error(`no coin covers ${need} zat`);
  return id(fitting[0][0]);
}
