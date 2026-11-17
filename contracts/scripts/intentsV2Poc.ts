import "dotenv/config";

import { isAddress, parseEther, formatEther } from "viem";

import { args } from "@whm/common";
import { wallet } from "@whm/common/evm";

const { requiredArg, optionalArg, requiredEnv, optionalEnv } = args;
const { getWallet } = wallet;

const NEAR_RPC = "https://free.rpc.fastnear.com";
const POA_RPC = "https://bridge.chaindefuser.com/rpc";
const SOLVER_RELAY = "https://solver-relay-v2.chaindefuser.com/rpc";

const MPC_SIGNER = "v1.signer";
const INTENTS = "intents.near";
const DOMAIN_ED25519 = 1;

const ETH_TOKEN_ID = "nep141:eth.omft.near";
const POA_MIN_DEPOSIT = 100_000_000_000n; // 1e11 wei — below this POA credits nothing

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * NIR v2 PoC — account derivation and the deposit leg, with nothing deployed.
 *
 * Probes the paths in docs/intents/spec.md that do not need IntentEmitter or IntentRouter to
 * exist. The trick is that MPC derivation is keyed on the *caller*, so any NEAR account you hold a
 * full-access key for stands in for the router: `derived_public_key` takes `predecessor` as an
 * argument (so anyone can compute anyone's account), and `sign` takes it from the runtime caller (so
 * only that account can sign for it). Substituting your own account therefore reproduces the
 * production derivation exactly, minus the VAA gate.
 *
 *   1. derive   — v1.signer.derived_public_key({predecessor, path, domain_id:1}) → A. Twice, plus a
 *                 second predecessor, to show determinism and that a different caller is disjoint.
 *   2. deposit  — POA deposit_address({account_id:A, chain}) → 0xN. Queried on eth:1 and eth:8453 to
 *                 measure the same-H160-different-token caveat rather than assume it.
 *   3. balance  — intents.near mt_batch_balance_of(A, [nep141:eth.omft.near]).
 *   4. quote    — solver relay ETH→--destAsset at --amount. THE gate: if no solver answers, stop.
 *   5. fund     — send native ETH to 0xN and poll until POA credits A. Real mainnet funds.
 *
 * Steps 1–4 are read-only. Step 5 runs only with --amount and moves real value.
 *
 * The signing leg (v1.signer.sign → MultiPayload → publish_intent) is NOT executed: it needs a NEAR
 * transaction signer, and `SignRequest`'s field names are the UNVERIFIED item in spec §7 — so this
 * prints the exact intent message and the `near` CLI command to run by hand, which is also how you
 * pin the nep413-vs-raw_ed25519 question against the real verifier.
 *
 * Env: RPC_ETHEREUM, SOLVER_RELAY_KEY?  (Partner Portal JWT — the 1Click JWT is NOT this)
 * Args: --nearAccount --path? --destAsset? --recipient? --amount? --pk? --wait?
 */

/** base58-decode. Local so the PoC carries no new dependency for fifteen lines. */
function b58decode(input: string): Uint8Array {
  let acc = 0n;
  for (const char of input) {
    const idx = B58.indexOf(char);
    if (idx < 0) throw new Error(`bad base58 char ${char}`);
    acc = acc * 58n + BigInt(idx);
  }

  const out: number[] = [];
  while (acc > 0n) {
    out.unshift(Number(acc & 0xffn));
    acc >>= 8n;
  }
  for (const char of input) {
    if (char !== "1") break;
    out.unshift(0);
  }
  return Uint8Array.from(out);
}

/**
 * Read-only NEAR contract call.
 * @param accountId Contract to read
 * @param methodName View method
 * @param callArgs JSON args, base64-encoded per the NEAR RPC contract
 * @returns The method's decoded JSON return value
 */
async function nearView<T>(accountId: string, methodName: string, callArgs: unknown): Promise<T> {
  const res = await fetch(optionalEnv("NEAR_RPC") ?? NEAR_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: accountId,
        method_name: methodName,
        args_base64: Buffer.from(JSON.stringify(callArgs)).toString("base64"),
      },
    }),
  });

  const body = await res.json();
  if (body.error) throw new Error(`near rpc: ${JSON.stringify(body.error)}`);
  // Contract panics surface here, not in body.error — a naive check returns undefined instead.
  if (body.result?.error) throw new Error(`near view ${accountId}.${methodName}: ${body.result.error}`);

  return JSON.parse(Buffer.from(body.result.result).toString()) as T;
}

/**
 * The intents account a (predecessor, path) pair derives.
 * @param predecessor Account the MPC keys derivation on — the router in production
 * @param path Derivation path; the router will pass `hex::encode(authPath)`, lowercase and unprefixed
 * @returns The Ed25519 public key and the 64-hex implicit account id it *is*
 */
async function deriveAccount(
  predecessor: string,
  path: string,
): Promise<{ publicKey: string; accountId: string }> {
  const publicKey = await nearView<string>(MPC_SIGNER, "derived_public_key", {
    path,
    predecessor,
    domain_id: DOMAIN_ED25519,
  });

  const raw = b58decode(publicKey.replace("ed25519:", ""));
  if (raw.length !== 32) throw new Error(`expected 32-byte pubkey, got ${raw.length}`);

  return { publicKey, accountId: Buffer.from(raw).toString("hex") };
}

/**
 * POA bridge deposit address for an intents account.
 * @param accountId 64-hex implicit account id
 * @param chain POA chain id, e.g. `eth:1`
 * @returns The H160 that funds must be delivered to
 */
async function depositAddress(accountId: string, chain: string): Promise<string> {
  const res = await fetch(optionalEnv("POA_RPC") ?? POA_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // params is an ARRAY of one object here, unlike NEAR's bare object.
    body: JSON.stringify({
      id: "1",
      jsonrpc: "2.0",
      method: "deposit_address",
      params: [{ account_id: accountId, chain }],
    }),
  });

  const body = await res.json();
  if (body.error) throw new Error(`poa rpc: ${JSON.stringify(body.error)}`);
  return body.result.address as string;
}

/**
 * Balance of one intents token id.
 * @param accountId Intents account to read
 * @param tokenId Intents token id, e.g. `nep141:eth.omft.near`
 * @returns Balance in the token's smallest unit
 */
async function intentsBalance(accountId: string, tokenId: string): Promise<bigint> {
  const balances = await nearView<(string | null)[]>(INTENTS, "mt_batch_balance_of", {
    account_id: accountId,
    token_ids: [tokenId],
  });
  return BigInt(balances[0] ?? "0");
}

async function main(): Promise<void> {
  const nearAccount = requiredArg("--nearAccount"); // stands in for the router
  const path = optionalArg("--path") ?? "dca-1";
  const destAsset = optionalArg("--destAsset") ?? "nep141:zec.omft.near";
  const recipient = optionalArg("--recipient");
  const amount = optionalArg("--amount"); // ETH, decimal — omit to skip funding
  const chain = optionalArg("--chain") ?? "eth:1";
  const waitSeconds = Number(optionalArg("--wait") ?? "900");

  // 1. Derive. Called twice for the same input, then once from a foreign predecessor: determinism and
  //    caller-keying are the two properties the whole design rests on, so measure both.
  const derived = await deriveAccount(nearAccount, path);
  const again = await deriveAccount(nearAccount, path);
  const foreign = await deriveAccount("attacker.near", path);

  console.log(`\n1. derive  predecessor=${nearAccount} path=${path} domain=${DOMAIN_ED25519}`);
  console.log(`   pubkey     ${derived.publicKey}`);
  console.log(`   account A  ${derived.accountId}`);
  console.log(`   determinism ${derived.accountId === again.accountId ? "OK" : "FAILED — not deterministic"}`);
  console.log(`   attacker.near → ${foreign.accountId.slice(0, 16)}… ${
    foreign.accountId === derived.accountId ? "FAILED — not caller-keyed" : "disjoint OK"
  }`);

  // 2. Deposit address. The same H160 comes back for every EVM chain but the credited token differs
  //    by where the transfer actually happened, so the address alone does not disambiguate.
  const target = await depositAddress(derived.accountId, chain);
  const onBase = await depositAddress(derived.accountId, "eth:8453");

  console.log(`\n2. deposit  ${chain} → ${target}`);
  console.log(`   eth:8453  → ${onBase}${target === onBase ? "   (same H160 — token differs by chain)" : ""}`);
  console.log(`   min deposit ${POA_MIN_DEPOSIT} wei (${formatEther(POA_MIN_DEPOSIT)} ETH) — below this credits nothing`);

  // 3. Balance. Also proves A needs no registration: the account id *is* the verifying key.
  const balanceBefore = await intentsBalance(derived.accountId, ETH_TOKEN_ID);
  console.log(`\n3. balance  ${ETH_TOKEN_ID} = ${balanceBefore}`);

  // 4. Quote. Per spec §7 this can invalidate the whole design, so it runs before any funding.
  const relayKey = optionalEnv("SOLVER_RELAY_KEY");
  const quoteAmount = amount ? parseEther(amount) : POA_MIN_DEPOSIT * 100_000n;

  if (!relayKey) {
    console.log(`\n4. quote    SKIPPED — set SOLVER_RELAY_KEY (Partner Portal JWT, not the 1Click one)`);
  } else {
    const res = await fetch(SOLVER_RELAY, {
      method: "POST",
      headers: { "content-type": "application/json", "X-API-Key": relayKey },
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "quote",
        params: [
          {
            defuse_asset_identifier_in: ETH_TOKEN_ID,
            defuse_asset_identifier_out: destAsset,
            exact_amount_in: quoteAmount.toString(),
            min_deadline_ms: 120_000,
          },
        ],
      }),
    });

    const body = await res.json();
    const quotes = body.result;
    console.log(`\n4. quote    ${ETH_TOKEN_ID} → ${destAsset}  in=${quoteAmount}`);
    if (!quotes || quotes.length === 0) {
      // Null for a liquid pair means the credential is wrong rather than the pair being unsupported.
      console.log(`   NO SOLVER  ${JSON.stringify(body)}`);
      console.log(`   Nothing downstream matters until this returns a quote — see spec §7.`);
    } else {
      for (const q of quotes) {
        console.log(`   out=${q.amount_out} hash=${q.quote_hash} expires=${q.expiration_time}`);
      }
    }
  }

  // 5. Fund. Real value: native ETH to 0xN, then poll until POA's watcher credits A.
  if (!amount) {
    console.log(`\n5. fund     SKIPPED — pass --amount <ETH> --pk <key> to move real funds`);
  } else {
    const value = parseEther(amount);
    if (value < POA_MIN_DEPOSIT) {
      throw new Error(`--amount ${value} wei is below POA's ${POA_MIN_DEPOSIT} minimum; it would not be credited`);
    }

    const privateKey = requiredArg("--pk") as `0x${string}`;
    const { publicClient, walletClient } = getWallet(requiredEnv("RPC_ETHEREUM"), 1, privateKey);
    if (!isAddress(target)) throw new Error(`POA returned a non-address: ${target}`);

    console.log(`\n5. fund     sending ${amount} ETH → ${target}`);
    const hash = await walletClient.sendTransaction({ to: target, value });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`   tx ${hash}`);

    const deadline = Date.now() + waitSeconds * 1000;
    let credited = balanceBefore;
    while (Date.now() < deadline) {
      credited = await intentsBalance(derived.accountId, ETH_TOKEN_ID);
      if (credited > balanceBefore) break;
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      process.stdout.write(".");
    }

    console.log(
      credited > balanceBefore
        ? `\n   credited ${credited - balanceBefore} (${ETH_TOKEN_ID}), balance ${credited}`
        : `\n   NOT CREDITED within ${waitSeconds}s — balance still ${credited}`,
    );
  }

  // 6/7. Signing and settlement, printed rather than run: this is where the router's authority sits,
  //      and `SignRequest`'s field names are the blocking unknown. Run the call by hand from
  //      --nearAccount and read back what the MPC actually signed.
  const balanceNow = await intentsBalance(derived.accountId, ETH_TOKEN_ID);
  if (balanceNow > 0n && recipient) {
    const message = {
      signer_id: derived.accountId,
      deadline: new Date(Date.now() + 120_000).toISOString(),
      intents: [
        { intent: "token_diff", diff: { [ETH_TOKEN_ID]: `-${balanceNow}`, [destAsset]: "<amount_out>" } },
        {
          intent: "ft_withdraw",
          token: destAsset.replace("nep141:", ""),
          receiver_id: destAsset.replace("nep141:", ""),
          amount: "<amount_out>",
          msg: recipient,
        },
      ],
    };

    console.log(`\n6. sign     run from ${nearAccount} — payload construction is UNVERIFIED (spec §7)`);
    console.log(`   message  ${JSON.stringify(message)}`);
    console.log(
      `   near contract call-function as-transaction ${MPC_SIGNER} sign ` +
        `json-args '{"payload":"<raw utf8 bytes or nep413 hash>","path":"${path}","domain_id":${DOMAIN_ED25519}}' ` +
        `prepaid-gas '250 Tgas' attached-deposit '1 yoctoNEAR' sign-as ${nearAccount} network-config mainnet`,
    );
    console.log(`   then assemble the MultiPayload (public_key ${derived.publicKey}) and publish_intent.`);
  } else {
    console.log(`\n6. sign     SKIPPED — needs a credited balance and --recipient`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
