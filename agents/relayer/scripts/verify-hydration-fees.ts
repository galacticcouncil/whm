/**
 * Reproduction for issue #45 (relayer: chain-parameterise the VAA submission helper) and its fix
 * rounds, most recently the round that replaced the `chain.fees.estimateFeesPerGas` viem hook with
 * an explicit `chainFees()` call inside `submit()` (review from Palo, Discord, 2026-09-03: pass the
 * chain through the clients, not as a separate argument; compute fees explicitly per call instead
 * of relying on viem's own per-client cache). Runs the REAL `hydrationClients()` / `submit()` /
 * `receiveMessage()` from `../src/engine/hydration` against REAL viem clients, with only the HTTP
 * transport mocked (`globalThis.fetch` intercepted, not the viem client objects), so the actual
 * signing path runs: real ABI encoding, a real local account (`viem/accounts`), real RLP/EIP-1559
 * serialization and signature.
 *
 * Five things are checked:
 *
 *   A. Fresh-client scenarios for the Hydration path: legacy (a contract check only — Hydration's
 *      `pallet-dynamic-evm-fee` makes this branch unreachable there today, see `../src/utils/fees`
 *      for the sourced claim), eip1559 with a priority-fee-reporting RPC, eip1559 with an RPC that
 *      rejects `eth_maxPriorityFeePerGas`. Each is compared against a PINNED_RAW_TX record below.
 *   B. A comparator sanity check: corrupting the pinned expectation must make (A) go red, so a
 *      clean run is not evidence of a vacuous "always equal" comparison.
 *   C. A SINGLE long-lived client (matching how `ntt`/`oracle` actually use `hydrationClients()`,
 *      once per process, not once per submission) across a `baseFeePerGas` flip between two real
 *      `receiveMessage()` calls, both directions (legacy -> eip1559 and eip1559 -> legacy). Because
 *      `submit()` calls `chainFees()` fresh on every call rather than letting viem infer a type
 *      from absent fee fields, each submission prices correctly off its own block; neither
 *      direction throws or mis-prices.
 *   D. The defect (C) no longer has, reproduced in memory by going around `submit()`: the same
 *      persistent client's `wallet.writeContract()` called directly, with no explicit fee fields,
 *      across the same kind of flip. This is viem's own `eip1559NetworkCache` (keyed by
 *      `client.uid`, written once per client lifetime — see
 *      `node_modules/viem/actions/wallet/prepareTransactionRequest.ts`) doing what it does when
 *      nothing overrides it: legacy -> eip1559 silently keeps signing legacy transactions after the
 *      block has moved on; eip1559 -> legacy throws `Eip1559FeesNotSupportedError` instead of
 *      falling back. This is the construction that shows why `submit()` sets fee fields explicitly
 *      on every call.
 *   E. `submit()` against a non-Hydration `Chain` (viem's `base`, with `rpcUrls` emptied so nothing
 *      can reach the network) goes through `chainFees()`'s generic branch, which is viem's own
 *      `client.estimateFeesPerGas()`. Confirms the generic branch actually runs and signs a
 *      well-formed EIP-1559 transaction, pinned like (A).
 *
 * Run with: npx tsx agents/relayer/scripts/verify-hydration-fees.ts
 * (from the repo root, or from agents/relayer/; either resolves node_modules), or
 * `pnpm --filter @whm/relayer verify:hydration-fees`.
 *
 * Manual source mutants run during this fix round (not re-run automatically, since each mutates a
 * checked-in file rather than an in-memory copy — restored after each check):
 *   - Drop the explicit fee fields from both `wallet.writeContract` branches in `submit()`
 *     (`../src/engine/hydration.ts`), rerun. All three (A) scenarios go red (byte mismatch — the
 *     Hydration branch no longer runs on every call the way the pinned transactions were captured).
 *   - Change `block.baseFeePerGas * 2n` to `* 3n` in `chainFees` (`../src/utils/fees.ts`), rerun.
 *     Both eip1559 (A) scenarios go red; the legacy (A) scenario and (E) are unaffected.
 *   - Make `chainFees` ignore `chain.id` so Hydration always takes the generic
 *     `client.estimateFeesPerGas()` branch, rerun. Both eip1559 (A) scenarios go red — viem's
 *     default base-fee multiplier is 1.2x, not this repo's 2x, so `maxFeePerGas` differs even when
 *     the RPC reports a priority fee; the legacy (A) scenario and (E) are unaffected.
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  getAddress,
  parseAbi,
  parseTransaction,
  type Chain,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

import { HYDRATION_EVM_CHAIN_ID } from "../src/chains";
import { hydrationClients, receiveMessage, submit, type ChainClients } from "../src/engine/hydration";

// Anvil/Hardhat's well-known default account #0 key. Public, funds-free, used only to sign a
// throwaway transaction that is never broadcast to a real chain.
const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

const TO = getAddress("0x00000000000000000000000000000000000000bb");
const VAA_BYTES = Buffer.from("cafebabe", "hex");
const ABI = parseAbi(["function receiveMessage(bytes vaa) external"]);
const NONCE = 42;
const GAS = 200_000n;
const GAS_PRICE = 5_000_000_000n; // legacy branch and eth_gasPrice fallback
const PRIORITY_FEE = 1_000_000_000n; // when the RPC reports one

// `base` (viem/chains) with its RPCs stripped so nothing here can reach the real network — the
// transport is always the mocked `http("http://mock-rpc.invalid")` below regardless.
const OFFLINE_BASE: Chain = { ...base, rpcUrls: { default: { http: [] } } };

type Scenario = {
  name: string;
  chainId: number;
  baseFeePerGas: bigint | null;
  priorityFeeSupported: boolean;
};

const SCENARIOS: Scenario[] = [
  { name: "legacy", chainId: HYDRATION_EVM_CHAIN_ID, baseFeePerGas: null, priorityFeeSupported: false },
  {
    name: "eip1559-with-priority-rpc",
    chainId: HYDRATION_EVM_CHAIN_ID,
    baseFeePerGas: 1_000_000_000n,
    priorityFeeSupported: true,
  },
  {
    name: "eip1559-no-priority-rpc",
    chainId: HYDRATION_EVM_CHAIN_ID,
    baseFeePerGas: 1_000_000_000n,
    priorityFeeSupported: false,
  },
];

const BASE_SCENARIO: Scenario = {
  name: "base-eip1559",
  chainId: base.id,
  baseFeePerGas: 800_000_000n,
  priorityFeeSupported: true,
};

/**
 * Raw signed transactions captured from THIS commit's `hydrationClients()` / `submit()` /
 * `receiveMessage()`, run against the fixture above (same TEST_KEY / TO / ABI / VAA_BYTES / NONCE /
 * GAS / GAS_PRICE / PRIORITY_FEE, one fresh client per scenario, via the same fetch-mocking approach
 * this file uses). Pinned as literal strings rather than re-derived from the fee formula, so a
 * change to that formula cannot make this comparison pass by construction, and rather than fetched
 * with `git show`, so this file keeps working as `master` moves.
 */
const PINNED_RAW_TX: Record<string, Hex> = {
  legacy:
    "0xf8cd2a85012a05f20083030d409400000000000000000000000000000000000000bb80b864f953cec700000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000004cafebabe000000000000000000000000000000000000000000000000000000008306c83fa0ef5e3066c11ba691a3b6f67bc10ae16c1d8fabb19b4a61191cf7f8c8830d8ee5a019ef4c7715b0775cb9e08180101afbf40c49c98c1328c7fd63babb18e2a95e94",
  "eip1559-with-priority-rpc":
    "0x02f8d38303640e2a843b9aca0084b2d05e0083030d409400000000000000000000000000000000000000bb80b864f953cec700000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000004cafebabe00000000000000000000000000000000000000000000000000000000c001a090bf5181aaa4668c21bc81fb38425a6c9c61c754650de9eecc8becbbb62eccdca00878aebb7fe79a8d39320e04e0daa6be6c5232b7f5b7d691e76a5cd149b3962b",
  "eip1559-no-priority-rpc":
    "0x02f8cf8303640e2a80847735940083030d409400000000000000000000000000000000000000bb80b864f953cec700000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000004cafebabe00000000000000000000000000000000000000000000000000000000c001a061c6b1ec15dca25d4ca533a7b57e8401a3be15fc7301a63f453959b72e7a9d6da022a9c60ec09c3bbbbf8605c5adc037b78bfac37bdf387e3725f64a6a6b24fe64",
  "base-eip1559":
    "0x02f8d28221052a843b9aca008474d33a0083030d409400000000000000000000000000000000000000bb80b864f953cec700000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000004cafebabe00000000000000000000000000000000000000000000000000000000c080a09004f1c8bce8ae44e289b6102271911bc681d8f601e3eb166cac72e4c479ffbda05d2feff18c437402711c8d13c13321df6805c11adb0cc8c681d3849b67cbb5bb",
};

type JsonRpcRequest = { jsonrpc: "2.0"; id: number; method: string; params?: unknown[] };

/**
 * Installs a fetch mock answering the JSON-RPC calls a submission provokes. `feed` is read on
 * every call, not captured once, so a persistent client (sections C/D) can have the block flip
 * between two submissions without reinstalling the mock. Any method this mock does not name comes
 * back as `-32601 Method not found`, which is also what makes `eth_fillTransaction` fall through to
 * viem's per-field path (the real behaviour, since no mock RPC here implements it).
 */
function installMock(feed: () => Scenario) {
  const original = globalThis.fetch;
  const capturedRaw: Hex[] = [];

  function answer(req: JsonRpcRequest): { jsonrpc: "2.0"; id: number; result?: unknown; error?: unknown } {
    const { id, method, params } = req;
    const scenario = feed();
    switch (method) {
      case "eth_chainId":
        return { jsonrpc: "2.0", id, result: `0x${scenario.chainId.toString(16)}` };
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
        if (!scenario.priorityFeeSupported) {
          return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
        }
        return { jsonrpc: "2.0", id, result: `0x${PRIORITY_FEE.toString(16)}` };
      case "eth_sendRawTransaction":
        capturedRaw.push((params as [Hex])[0]);
        return { jsonrpc: "2.0", id, result: `0x${"22".repeat(32)}` };
      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `mock: unhandled method ${method}` } };
    }
  }

  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
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
  };
}

async function actualRawTx(scenario: Scenario): Promise<Hex> {
  const mock = installMock(() => scenario);
  try {
    const clients = await hydrationClients("http://mock-rpc.invalid", TEST_KEY);
    await receiveMessage(clients, ABI, TO, VAA_BYTES, NONCE);
    const raw = mock.rawTxs()[0];
    if (!raw) throw new Error("eth_sendRawTransaction was never called");
    return raw;
  } finally {
    mock.restore();
  }
}

/** Section E: a non-Hydration `ChainClients`, built the same way `hydrationClients` builds one,
 * just against `OFFLINE_BASE` instead — there is no factory for this in `../src/engine/hydration`
 * (Base is issue #46), so this test builds the pair directly. */
async function baseClients(): Promise<ChainClients> {
  const account = privateKeyToAccount(TEST_KEY);
  const publicClient = createPublicClient({ chain: OFFLINE_BASE, transport: http("http://mock-rpc.invalid") });
  const wallet = createWalletClient({
    account,
    chain: OFFLINE_BASE,
    transport: http("http://mock-rpc.invalid"),
  });
  return { account, publicClient, wallet };
}

async function actualBaseRawTx(): Promise<Hex> {
  const mock = installMock(() => BASE_SCENARIO);
  try {
    const clients = await baseClients();
    await submit(clients, { to: TO, abi: ABI, functionName: "receiveMessage", args: [`0x${VAA_BYTES.toString("hex")}`] }, NONCE);
    const raw = mock.rawTxs()[0];
    if (!raw) throw new Error("eth_sendRawTransaction was never called");
    return raw;
  } finally {
    mock.restore();
  }
}

/** One client, used for two `receiveMessage` submissions, with the block flipping in between —
 * the shape production actually runs in (`hydrationClients()` is called once at process start). */
async function persistentClientFlip(
  first: Scenario,
  second: Scenario,
): Promise<{ tx1: Hex; secondCall: () => Promise<Hex> }> {
  let current = first;
  const mock = installMock(() => current);
  const clients = await hydrationClients("http://mock-rpc.invalid", TEST_KEY);

  await receiveMessage(clients, ABI, TO, VAA_BYTES, 1);
  const tx1 = mock.rawTxs()[0]!;

  current = second;
  return {
    tx1,
    secondCall: async () => {
      try {
        await receiveMessage(clients, ABI, TO, VAA_BYTES, 2);
        const tx2 = mock.rawTxs()[1];
        if (!tx2) throw new Error("eth_sendRawTransaction was never called on the second submission");
        return tx2;
      } finally {
        mock.restore();
      }
    },
  };
}

/** Section D's mutant: same shape as `persistentClientFlip`, but calls `wallet.writeContract`
 * directly with no fee fields, going around `submit()` (and so around `chainFees`) entirely. This
 * is what a hypothetical `submit()` that forgot to set fee fields would produce. */
async function mutantPersistentFlip(
  first: Scenario,
  second: Scenario,
): Promise<{ tx1: Hex; secondCall: () => Promise<Hex | { threw: true }> }> {
  let current = first;
  const mock = installMock(() => current);
  const clients = await hydrationClients("http://mock-rpc.invalid", TEST_KEY);
  const args = [`0x${VAA_BYTES.toString("hex")}`] as const;

  await clients.wallet.writeContract({
    address: TO,
    abi: ABI,
    functionName: "receiveMessage",
    args,
    nonce: 1,
    account: clients.account,
  });
  const tx1 = mock.rawTxs()[0]!;

  current = second;
  return {
    tx1,
    secondCall: async () => {
      try {
        await clients.wallet.writeContract({
          address: TO,
          abi: ABI,
          functionName: "receiveMessage",
          args,
          nonce: 2,
          account: clients.account,
        });
        const tx2 = mock.rawTxs()[1];
        if (!tx2) throw new Error("eth_sendRawTransaction was never called on the second submission");
        return tx2;
      } catch {
        return { threw: true as const };
      } finally {
        mock.restore();
      }
    },
  };
}

/** True when a parsed transaction has all the fields its own `type` requires and none of the
 * other shape's, i.e. it is not a half-set legacy/EIP-1559 hybrid. */
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

  // A: pinned byte comparison, fresh client per scenario. `legacy` is a contract check only —
  // Hydration's dynamic-evm-fee pallet makes this branch unreachable there today (see
  // ../src/utils/fees).
  for (const scenario of SCENARIOS) {
    const actual = await actualRawTx(scenario);
    const label =
      scenario.name === "legacy"
        ? `${scenario.name} (contract check — unreachable on Hydration today)`
        : scenario.name;
    const expected = PINNED_RAW_TX[scenario.name]!;
    record(actual === expected, label, () => {
      console.log(`  expected: ${expected}`);
      console.log(`  actual:   ${actual}`);
    });
  }

  // B: comparator sanity check. Corrupt the pinned expectation, confirm (A)'s comparison would
  // have gone red. Demonstrates only that the comparator can tell two transactions apart; the
  // mutants that matter are the manual source ones in the header and the constructed mutant in D.
  {
    const scenario = SCENARIOS[1]!; // eip1559-with-priority-rpc
    const actual = await actualRawTx(scenario);
    const corruptedExpected = (PINNED_RAW_TX[scenario.name]!.slice(0, -1) + "0") as Hex;
    record(actual !== corruptedExpected, "comparator sanity check (corrupted pinned hex by one nibble)");
  }

  // C: the fixed behaviour, by construction. One client, block flips between submissions. Each
  // `receiveMessage` call runs `chainFees` fresh, so both directions price correctly off their own
  // block — neither throws, and neither carries the previous submission's fee shape forward.
  {
    const legacyScenario = SCENARIOS[0]!;
    const eipScenario = SCENARIOS[1]!;

    const upgrade = await persistentClientFlip(legacyScenario, eipScenario);
    const tx1u = parseTransaction(upgrade.tx1);
    const tx2u = parseTransaction(await upgrade.secondCall());
    record(
      isWellFormed(tx1u) && tx1u.type === "legacy" && isWellFormed(tx2u) && tx2u.type === "eip1559",
      "persistent client, legacy -> eip1559 block flip: each submission prices from its own block",
      () => console.log("  tx1:", tx1u, "\n  tx2:", tx2u),
    );

    const downgrade = await persistentClientFlip(eipScenario, legacyScenario);
    const tx1d = parseTransaction(downgrade.tx1);
    const tx2d = parseTransaction(await downgrade.secondCall());
    record(
      isWellFormed(tx1d) && tx1d.type === "eip1559" && isWellFormed(tx2d) && tx2d.type === "legacy",
      "persistent client, eip1559 -> legacy block flip: each submission prices from its own block",
      () => console.log("  tx1:", tx1d, "\n  tx2:", tx2d),
    );
  }

  // D: the defect (C) no longer has, reproduced by going around `submit()`. Same persistent
  // client, but `wallet.writeContract` called directly with no fee fields, so viem's own
  // `eip1559NetworkCache` (written once per client) makes the decision instead of `chainFees`.
  {
    const legacyScenario = SCENARIOS[0]!;
    const eipScenario = SCENARIOS[1]!;

    const upgrade = await mutantPersistentFlip(legacyScenario, eipScenario);
    const tx2uRaw = await upgrade.secondCall();
    const upgradeWrong =
      typeof tx2uRaw !== "object" ? parseTransaction(tx2uRaw).type !== "eip1559" : false;
    record(
      upgradeWrong,
      "mutant (no explicit fee fields): legacy -> eip1559 flip silently keeps signing legacy",
      () => console.log("  tx2 (should be eip1559, mutant's cache says otherwise):", tx2uRaw),
    );

    const downgrade = await mutantPersistentFlip(eipScenario, legacyScenario);
    const tx2dRaw = await downgrade.secondCall();
    const downgradeThrew = typeof tx2dRaw === "object" && "threw" in tx2dRaw;
    record(
      downgradeThrew,
      "mutant (no explicit fee fields): eip1559 -> legacy flip throws instead of signing",
      () => console.log("  tx2:", tx2dRaw),
    );
  }

  // E: `submit()` against a non-Hydration chain goes through `chainFees`'s generic branch —
  // viem's own `client.estimateFeesPerGas()` — and signs a well-formed EIP-1559 transaction.
  {
    const actual = await actualBaseRawTx();
    const parsed = parseTransaction(actual);
    const wellFormed = isWellFormed(parsed) && parsed.type === "eip1559";
    const expected = PINNED_RAW_TX["base-eip1559"]!;
    record(
      wellFormed && actual === expected,
      "base (non-Hydration): submit() signs a well-formed eip1559 tx via the generic branch",
      () => {
        console.log("  expected:", expected);
        console.log("  actual:  ", actual);
      },
    );
  }

  if (failed) {
    console.error("\nverify-hydration-fees: FAILED");
    process.exit(1);
  }
  console.log("\nverify-hydration-fees: all checks passed");
}

main();
