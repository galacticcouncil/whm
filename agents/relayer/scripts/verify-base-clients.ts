/**
 * Verification for the Base chain client and signer. Runs the REAL `baseClients()`
 * from `../src/engine/base`, the REAL `receiveMessage()`/`submit()` from `../src/engine/hydration`
 * (destination chain travels on `ChainClients`, so it works unchanged against Base), and the REAL
 * `createQueue()` from `../src/engine/queue`, against real viem clients, with only the HTTP
 * transport mocked (`globalThis.fetch` intercepted, not the viem client objects) — the same
 * technique `verify-hydration-fees.ts` uses, so this exercises the actual signing and queueing
 * paths rather than a description of them.
 *
 * Checks, each mutation-verified (break the property, confirm the named check goes red alone,
 * restore, confirm green):
 *
 *   1. Chain-id assertion: the RPC reporting a chain other than 8453 makes `baseClients` throw a
 *      named, legible error naming `RPC_BASE` and both the reported and expected ids — the same
 *      mechanism `hydrationClients` uses. Asserted against the exact message text, not a weak
 *      substring (a bare `.includes("1")` would pass against almost any error).
 *
 *   2. Fresh-per-call pricing: ONE `baseClients()` instance submits twice, with the block's
 *      `baseFeePerGas` changing between the two calls (which real Base blocks do, submission to
 *      submission). Both transactions must be well-formed EIP-1559 (never legacy, never half-set),
 *      each priced off the block it was actually built against (checked against viem's own default
 *      fee formula — `chainFees`'s generic branch calls `client.estimateFeesPerGas()`, computed
 *      here from viem's source rather than guessed), and signed by `KEY_A`'s recovered address
 *      specifically — not merely "some account". `submit()` (`../src/engine/hydration.ts`) calls
 *      `chainFees()` fresh on every call and sets fee fields explicitly on every write, so there is
 *      no per-client memoization for a persistent Base client to go stale against — unlike the
 *      pre-#21 shape, where a chain-level `fees.estimateFeesPerGas` hook plus viem's own
 *      per-client `eip1559NetworkCache` made a persistent client's *second* submission a real risk
 *      (see `../src/engine/hydration.ts`'s `ChainClients` doc comment, and
 *      `verify-hydration-fees.ts` groups C/D for that mechanism, reproduced there against
 *      Hydration). This check only establishes that Base's real factory produces correct,
 *      independently-priced transactions across two calls; it does not exercise a cache because
 *      `submit` never consults one.
 *
 *   3. Falsy rpcUrl throws before any request: `baseClients("")` and `baseClients(undefined)` must
 *      both throw `UrlRequiredError` with the fetch call count still at zero — `../src/chains.ts`'s
 *      `base` empties out viem's built-in `rpcUrls` so `http(rpcUrl)`'s own fallback
 *      (`url || chain?.rpcUrls.default.http[0]`) has nothing to fall back to. A counting stub
 *      (not the JSON-RPC mock) stands in for `fetch` here specifically so that a client which
 *      proceeds to contact viem's built-in `https://mainnet.base.org` is caught by the fetch count,
 *      not by the shape of the mocked response.
 *
 *   4. Key isolation: `PRIVKEY_BASE` unset falls back to nothing — `privateKeyBase()` throws rather
 *      than silently reading `PRIVKEY`, and when both are set they resolve to different accounts.
 *      Mutation: a fallback-shaped version of the function (`PRIVKEY_BASE ?? PRIVKEY`), exercised in
 *      place, confirmed to hide the very failure this check exists to surface.
 *
 *   5. Low-gas alerting names the chain correctly for a Base client, by construction: a real
 *      `createQueue()` driven by a real `baseClients()` public client (chain id 8453) is run through
 *      `init()`'s balance check, and the captured "Gas: ..." log line is asserted to *include*
 *      `base (8453)` — `engine/queue.ts`'s own `CHAIN_NAMES` map, exercised, not quoted. Sanity
 *      check: an otherwise-identical client reporting an unmapped chain id produces the generic
 *      `chain (N)` fallback instead, so the assertion is shown able to fail before it is trusted to
 *      pass.
 *
 * Manual source mutants run during this fix round (not reproduced in-script, since each mutates a
 * checked-in file rather than an in-memory copy — restored after each check):
 *   - Remove the chain-id assertion from `baseClients` (`../src/engine/base.ts`). Check 1 alone
 *     goes red: the mismatched-RPC scenario resolves instead of throwing (both its sub-assertions
 *     fail), while every other check is unaffected.
 *   - `baseClients` returns a `wallet` built against `hydration` (imported from `../chains`) instead
 *     of `base`, `publicClient` left pointing at `base`. Three of check 1's/2's five assertions go
 *     red: check 1's "matching RPC resolves cleanly" (`clients.wallet.chain.id` is now Hydration's
 *     id, not Base's), and two of check 2's five sub-assertions — the pricing-formula match (fees
 *     now come from `chainFees`'s Hydration-specific branch, `baseFeePerGas * 2n + priorityFee`,
 *     not the generic branch's `* 1.2 + priorityFee` this check computes) and the chain-id
 *     sub-assertion (`tx1.chainId`/`tx2.chainId` now carry Hydration's id). Check 1's mismatched-RPC
 *     assertion, the signer sub-assertion, and the URL sub-assertion stay green (they read from
 *     `publicClient.getChainId()`, the recovered signer, and the mocked fetch target — none of
 *     which this mutation touches) — as do checks 3, 4, 5, which never reach `wallet.chain` at all.
 *   - Revert `../src/chains.ts`'s `base` to viem's unmodified built-in (drop the `rpcUrls`
 *     override). Check 3 alone goes red, with a nonzero fetch count — a falsy `rpcUrl` now resolves
 *     to `https://mainnet.base.org` instead of throwing — while every other check, which always
 *     passes a real (mocked) URL, is unaffected.
 *
 * Run with: npx tsx agents/relayer/scripts/verify-base-clients.ts
 * (from the repo root, or from agents/relayer/; either resolves node_modules), or
 * `pnpm --filter @whm/relayer verify:base-clients`.
 */
import {
  createPublicClient,
  getAddress,
  http,
  parseAbi,
  parseTransaction,
  recoverTransactionAddress,
  UrlRequiredError,
  type Hex,
  type TransactionSerialized,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { baseClients } from "../src/engine/base";
import { BASE_EVM_CHAIN_ID } from "../src/chains";
import { privateKey, privateKeyBase } from "../src/config";
import { receiveMessage } from "../src/engine/hydration";
import { createQueue } from "../src/engine/queue";
import logger from "../src/logger";

// KEY_A is Anvil/Hardhat's well-known default account #0 key: public, funds-free, used only to sign
// throwaway transactions that are never broadcast to a real chain. KEY_B is an arbitrary second
// 32-byte key, needed only to be *distinct* from KEY_A for the key-isolation check below — never
// used to sign anything, so it carries no funds-free provenance requirement of its own.
const KEY_A = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const KEY_B = "0x9efd4a62b34034205675395eed693d4f4709688111220665ddd61c6567c4169a" as const;
const KEY_A_ADDRESS = privateKeyToAccount(KEY_A).address;

const MOCK_RPC_URL = "http://mock-rpc.invalid";
const TO = getAddress("0x00000000000000000000000000000000000000bb");
const VAA_BYTES = Buffer.from("cafebabe", "hex");
const ABI = parseAbi(["function receiveMessage(bytes vaa) external"]);
const GAS = 200_000n;
const PRIORITY_FEE = 1_000_000_000n;
// Legacy gasPrice fallback, independent of whatever `baseFeePerGas` a scenario carries — real chains
// answer `eth_gasPrice` regardless of EIP-1559 support.
const GAS_PRICE = 5_000_000_000n;

type JsonRpcRequest = { jsonrpc: "2.0"; id: number; method: string; params?: unknown[] };
type Scenario = { baseFeePerGas: bigint | null; balance?: bigint };

/**
 * Installs a fetch mock answering the JSON-RPC calls a Base submission (or queue balance check)
 * provokes, for a client built against chain `chainId`. `feed` is read on every call, not captured
 * once, so a persistent client can see the block's `baseFeePerGas` change between two submissions.
 * Every request's target URL is captured too, so a client that ignores the `rpcUrl` it was given
 * (e.g. falling back to a chain's built-in default) is visible to the caller.
 */
function installMock(chainId: number, feed: () => Scenario) {
  const original = globalThis.fetch;
  const capturedRaw: Hex[] = [];
  const capturedUrls: string[] = [];

  function answer(req: JsonRpcRequest): { jsonrpc: "2.0"; id: number; result?: unknown; error?: unknown } {
    const { id, method, params } = req;
    const scenario = feed();
    switch (method) {
      case "eth_chainId":
        return { jsonrpc: "2.0", id, result: `0x${chainId.toString(16)}` };
      case "eth_call":
        return { jsonrpc: "2.0", id, result: "0x" };
      case "eth_estimateGas":
        return { jsonrpc: "2.0", id, result: `0x${GAS.toString(16)}` };
      case "eth_getBlockByNumber":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            number: "0x1",
            baseFeePerGas:
              scenario.baseFeePerGas === null ? undefined : `0x${scenario.baseFeePerGas.toString(16)}`,
          },
        };
      case "eth_gasPrice":
        return { jsonrpc: "2.0", id, result: `0x${GAS_PRICE.toString(16)}` };
      case "eth_maxPriorityFeePerGas":
        return { jsonrpc: "2.0", id, result: `0x${PRIORITY_FEE.toString(16)}` };
      case "eth_getBalance":
        return { jsonrpc: "2.0", id, result: `0x${(scenario.balance ?? 10n ** 18n).toString(16)}` };
      case "eth_getTransactionCount":
        return { jsonrpc: "2.0", id, result: "0x0" };
      case "eth_sendRawTransaction":
        capturedRaw.push((params as [Hex])[0]);
        return { jsonrpc: "2.0", id, result: `0x${"22".repeat(32)}` };
      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `mock: unhandled method ${method}` } };
    }
  }

  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    capturedUrls.push(String(url));
    const body = JSON.parse((init?.body as string) ?? "{}");
    const payload = Array.isArray(body) ? body.map(answer) : answer(body);
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  return {
    restore: () => {
      globalThis.fetch = original;
    },
    rawTxs: () => capturedRaw,
    urls: () => capturedUrls,
  };
}

/** True when a parsed transaction has all the fields its own `type` requires and none of the other
 * shape's, i.e. it is not a half-set legacy/EIP-1559 hybrid. */
function isWellFormed(tx: ReturnType<typeof parseTransaction>): boolean {
  if (tx.type === "legacy") {
    return typeof (tx as { gasPrice?: bigint }).gasPrice === "bigint";
  }
  const eip1559 = tx as { maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint };
  return typeof eip1559.maxFeePerGas === "bigint" && typeof eip1559.maxPriorityFeePerGas === "bigint";
}

async function main() {
  let failed = false;
  const record = (ok: boolean, label: string, detail?: () => void) => {
    console.log(`[${ok ? "PASS" : "FAIL"}] ${label}`);
    if (!ok) {
      detail?.();
      failed = true;
    }
  };

  // ---- 1. Chain-id assertion --------------------------------------------------------------
  {
    const WRONG_CHAIN_ID = 1; // Ethereum mainnet — the mismatch this assertion exists to catch.
    const expectedMessage = `RPC_BASE returned chain ${WRONG_CHAIN_ID}; expected ${BASE_EVM_CHAIN_ID}`;

    const mock = installMock(WRONG_CHAIN_ID, () => ({ baseFeePerGas: 1_000_000_000n }));
    let error: Error | undefined;
    try {
      await baseClients(MOCK_RPC_URL, KEY_A);
    } catch (e) {
      error = e as Error;
    } finally {
      mock.restore();
    }
    // Exact text, not a substring like `.includes("1")` — which would pass against almost any
    // error message, including one naming the wrong variable or the wrong ids entirely.
    record(
      error !== undefined && error.message === expectedMessage,
      "chain-id assertion: mismatched RPC (reports 1) throws a named, legible error",
      () => console.log("  expected:", expectedMessage, "\n  actual:  ", error?.message),
    );

    // Restore: RPC correctly reports 8453 -> no throw, clients resolve, and both clients agree on
    // Base's chain id (there is no separate `chain` field left to check — see `ChainClients`).
    const goodMock = installMock(BASE_EVM_CHAIN_ID, () => ({ baseFeePerGas: 1_000_000_000n }));
    let resolvedOk = false;
    try {
      const clients = await baseClients(MOCK_RPC_URL, KEY_A);
      resolvedOk =
        clients.wallet.chain.id === BASE_EVM_CHAIN_ID && clients.publicClient.chain.id === BASE_EVM_CHAIN_ID;
    } catch {
      resolvedOk = false;
    } finally {
      goodMock.restore();
    }
    record(resolvedOk, "chain-id assertion: matching RPC (reports 8453) resolves cleanly");
  }

  // ---- 2. Fresh-per-call pricing --------------------------------------------------------------
  {
    const feeOf = (tx: ReturnType<typeof parseTransaction>): bigint | undefined =>
      (tx as { maxFeePerGas?: bigint }).maxFeePerGas;

    const baseFee1 = 1_000_000_000n;
    const baseFee2 = 5_000_000_000n; // a real base-fee move between two Base blocks
    let current: Scenario = { baseFeePerGas: baseFee1 };
    const mock = installMock(BASE_EVM_CHAIN_ID, () => current);
    const clients = await baseClients(MOCK_RPC_URL, KEY_A);

    await receiveMessage(clients, ABI, TO, VAA_BYTES, 1);
    const raw1 = mock.rawTxs()[0]!;

    current = { baseFeePerGas: baseFee2 };
    await receiveMessage(clients, ABI, TO, VAA_BYTES, 2);
    const raw2 = mock.rawTxs()[1]!;
    const urls = mock.urls();
    mock.restore();

    const tx1 = parseTransaction(raw1);
    const tx2 = parseTransaction(raw2);

    record(
      isWellFormed(tx1) && isWellFormed(tx2) && tx1.type !== "legacy" && tx2.type !== "legacy",
      "fresh-per-call pricing: both submissions are well-formed EIP-1559 transactions",
      () => console.log("  tx1:", tx1, "\n  tx2:", tx2),
    );

    // viem's own default `estimateFeesPerGas` (`chainFees`'s generic branch, no chain-level fee
    // hook is installed on `base` — see ../src/chains.ts):
    // maxFeePerGas = baseFeePerGas * baseFeeMultiplier(default 1.2) + maxPriorityFeePerGas. Computed
    // here from the untouched viem source (actions/public/estimateFeesPerGas.ts), not guessed, so a
    // match is evidence the real per-block value drove the signed transaction rather than a stale
    // one from client construction.
    const expectedFee = (baseFeePerGas: bigint) => (baseFeePerGas * 12n) / 10n + PRIORITY_FEE;
    record(
      feeOf(tx1) !== feeOf(tx2) &&
        feeOf(tx1) === expectedFee(baseFee1) &&
        feeOf(tx2) === expectedFee(baseFee2),
      "fresh-per-call pricing: each submission prices off its own block's baseFeePerGas",
      () =>
        console.log(
          "  baseFee1:", baseFee1, "fee1:", feeOf(tx1), "expected:", expectedFee(baseFee1),
          "\n  baseFee2:", baseFee2, "fee2:", feeOf(tx2), "expected:", expectedFee(baseFee2),
        ),
    );

    // The detector must see WHICH key signed and WHICH chain id and endpoint were used, not just "a
    // well-formed, correctly-priced tx arrived from somewhere" — a mutant reading PRIVKEY instead of
    // the given `key` argument, a mutant building `wallet` against `hydration` instead of `base`, or
    // one hardcoding the transport to a real endpoint, all produce well-formed, correctly-priced
    // transactions too. Recovering the signer from the RAW signed transaction (not trusting
    // `parseTransaction`'s `from`, which viem does not even populate) catches the first; the
    // `chainId` on the parsed transaction catches the second; capturing the actual fetch target URL
    // catches the third.
    // `eth_sendRawTransaction` hands over a `Hex`; viem types the recovery input as the narrower
    // `TransactionSerialized`, which nothing at runtime distinguishes from it.
    const signer1 = await recoverTransactionAddress({
      serializedTransaction: raw1 as TransactionSerialized,
    });
    const signer2 = await recoverTransactionAddress({
      serializedTransaction: raw2 as TransactionSerialized,
    });
    record(
      signer1 === KEY_A_ADDRESS && signer2 === KEY_A_ADDRESS,
      "fresh-per-call pricing: both submissions are signed by KEY_A's recovered address, not some other key",
      () => console.log("  expected:", KEY_A_ADDRESS, "\n  signer1: ", signer1, "\n  signer2: ", signer2),
    );
    record(
      tx1.chainId === BASE_EVM_CHAIN_ID && tx2.chainId === BASE_EVM_CHAIN_ID,
      "fresh-per-call pricing: both submissions carry Base's chain id",
      () => console.log("  tx1.chainId:", tx1.chainId, "tx2.chainId:", tx2.chainId),
    );
    // `startsWith`, not `===`: viem's http transport can normalize a bare host into a URL with a
    // trailing slash, so an exact-equality check here would be a false negative on the real client,
    // not just a missed mutant.
    record(
      urls.length > 0 && urls.every((u) => u.startsWith(MOCK_RPC_URL)),
      "fresh-per-call pricing: every request targets the RPC url baseClients() was given",
      () => console.log("  urls:", urls),
    );
  }

  // ---- 3. Falsy rpcUrl: no public-endpoint fallback ---------------------------------------------
  {
    // A counting stub, not the JSON-RPC mock: if `baseClients` ever calls fetch here, that is
    // itself the defect (a real request going out to resolve a chain id), whether or not the
    // response would have been usable. A valid chain-id response is provided anyway so a client
    // that (incorrectly) proceeds past the URL check fails on the assertion below, not on an
    // unrelated mock-shape error.
    const original = globalThis.fetch;
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount++;
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: `0x${BASE_EVM_CHAIN_ID.toString(16)}` }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    let emptyStringThrew = false;
    let undefinedThrew = false;
    try {
      try {
        await baseClients("", KEY_A);
      } catch (e) {
        emptyStringThrew = e instanceof UrlRequiredError;
      }
      try {
        await baseClients(undefined as unknown as string, KEY_A);
      } catch (e) {
        undefinedThrew = e instanceof UrlRequiredError;
      }
    } finally {
      globalThis.fetch = original;
    }

    record(
      emptyStringThrew && undefinedThrew && fetchCount === 0,
      "falsy rpcUrl throws UrlRequiredError before any request, no public-endpoint fallback",
      () =>
        console.log(
          "  emptyStringThrew:", emptyStringThrew,
          "undefinedThrew:", undefinedThrew,
          "fetchCount:", fetchCount,
        ),
    );
  }

  // ---- 4. Key isolation ---------------------------------------------------------------------
  {
    const savedPrivkey = process.env.PRIVKEY;
    const savedPrivkeyBase = process.env.PRIVKEY_BASE;
    try {
      // Real behavior: distinct env vars resolve to distinct accounts. `privateKey`/`privateKeyBase`
      // both read `process.env` lazily on every call (see ../src/config.ts) — no module reload or
      // cache-busting is needed to see a freshly-set env var take effect.
      process.env.PRIVKEY = KEY_A;
      process.env.PRIVKEY_BASE = KEY_B;
      record(
        privateKeyBase() === KEY_B && privateKey() === KEY_A && privateKeyBase() !== privateKey(),
        "key isolation: PRIVKEY_BASE and PRIVKEY resolve to different keys",
      );

      // Real behavior: PRIVKEY_BASE unset (even with PRIVKEY set) throws rather than falling back.
      delete process.env.PRIVKEY_BASE;
      let threw = false;
      try {
        privateKeyBase();
      } catch {
        threw = true;
      }
      record(threw, "key isolation: privateKeyBase() throws when PRIVKEY_BASE is unset, no PRIVKEY fallback");

      // Mutation: a fallback-shaped implementation, exercised directly (not by editing config.ts on
      // disk), confirming it would hide exactly the failure the check above exists to catch.
      const fallbackPrivateKeyBase = (): string => process.env.PRIVKEY_BASE || process.env.PRIVKEY || "";
      const mutantHidesIt = fallbackPrivateKeyBase() === process.env.PRIVKEY;
      record(
        mutantHidesIt,
        "source mutant (PRIVKEY_BASE falling back to PRIVKEY) makes the isolation check go red",
      );
    } finally {
      if (savedPrivkey === undefined) delete process.env.PRIVKEY;
      else process.env.PRIVKEY = savedPrivkey;
      if (savedPrivkeyBase === undefined) delete process.env.PRIVKEY_BASE;
      else process.env.PRIVKEY_BASE = savedPrivkeyBase;
    }
  }

  // ---- 5. Low-gas alerting names the chain correctly (queue.ts's 8453 -> "base" map) --------
  {
    /**
     * Runs `createQueue().init()` (the real balance check) against a client for `chainId` and
     * returns the "Gas: ..." log line it produces. `viaBaseClients` uses the real, production
     * `baseClients()` factory (chain id 8453 only, since it asserts); the unmapped-id sanity check
     * below cannot go through it, so it builds a plain client directly — same public actions, no
     * assertion — to exercise `engine/queue.ts`'s label lookup in isolation.
     */
    async function gasLogLine(chainId: number, viaBaseClients: boolean): Promise<string> {
      const mock = installMock(chainId, () => ({ baseFeePerGas: 1_000_000_000n, balance: 10n ** 18n }));
      const lines: string[] = [];
      const originalInfo = logger.info.bind(logger);
      (logger as unknown as { info: (msg: string) => void }).info = (msg: string) => {
        lines.push(String(msg));
      };
      try {
        const { account, publicClient } = viaBaseClients
          ? await baseClients(MOCK_RPC_URL, KEY_A)
          : {
              account: privateKeyToAccount(KEY_A),
              publicClient: createPublicClient({ transport: http(MOCK_RPC_URL) }),
            };
        const queue = createQueue({ publicClient, account, warnMultiplier: 50n });
        await queue.init();
      } finally {
        (logger as unknown as { info: typeof originalInfo }).info = originalInfo;
        mock.restore();
      }
      return lines.find((l) => l.startsWith("Gas: ")) ?? "";
    }

    const baseLine = await gasLogLine(BASE_EVM_CHAIN_ID, true);
    record(
      baseLine.includes("base (8453)"),
      "low-gas alerting: a real baseClients() client's balance check names the chain 'base (8453)'",
      () => console.log("  line:", baseLine),
    );

    // Sanity check: an unmapped chain id falls back to the generic label, so the assertion above is
    // shown able to fail before it is trusted to pass — engine/queue.ts's CHAIN_NAMES map is doing
    // the work, not a coincidence of this script's assertion. baseClients() would reject this chain
    // id outright (check 1), so this goes through a plain client instead — that is real production
    // code (engine/queue.ts) too, just not reached via baseClients().
    const unmappedId = 999_999;
    const unmappedLine = await gasLogLine(unmappedId, false);
    record(
      unmappedLine.includes(`chain (${unmappedId})`) && !unmappedLine.includes("base"),
      "low-gas alerting sanity check: an unmapped chain id falls back to the generic 'chain (N)' label",
      () => console.log("  line:", unmappedLine),
    );
  }

  if (failed) {
    console.error("\nverify-base-clients: FAILED");
    process.exit(1);
  }
  console.log("\nverify-base-clients: all checks passed");
}

main();
