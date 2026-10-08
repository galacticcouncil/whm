/**
 * Reproduction for issue #45 (relayer: chain-parameterise the VAA submission helper) and its two
 * fix rounds. Runs the REAL `hydrationClients()` + `receiveMessage()` from `../src/engine/hydration`
 * against REAL viem clients, with only the HTTP transport mocked (`globalThis.fetch` intercepted,
 * not the viem client objects), so the actual signing path runs: real ABI encoding, a real local
 * account (`viem/accounts`), real RLP/EIP-1559 serialization and signature.
 *
 * Four things are checked:
 *
 *   A. Fresh-client scenarios (legacy, eip1559 with a priority-fee-reporting RPC, eip1559 without
 *      one) each produce the exact raw signed transaction PINNED_RAW_TX records below.
 *   B. A comparator sanity check: corrupting the pinned expectation must make (A) go red, so a
 *      clean run is not evidence of a vacuous "always equal" comparison.
 *   C. The fix round 2 defect, by construction: a SINGLE long-lived client (matching how
 *      `ntt`/`oracle` actually use `hydrationClients()`, once per process, not once per
 *      submission) across a `baseFeePerGas` flip between two submissions. This is the shape the
 *      first round of this check missed, because it built a fresh client per scenario and the
 *      defect only shows up when viem's per-client `eip1559NetworkCache` survives across calls.
 *   D. A mutant that perturbs the source (in memory, not on disk): swaps `hydration`'s
 *      `fees.estimateFeesPerGas` for the pre-fix, block-only version and reruns (C)'s flip,
 *      confirming that version signs a malformed transaction where the fixed version does not.
 *
 * Run with: npx tsx agents/relayer/scripts/verify-hydration-fees.ts
 * (from the repo root, or from agents/relayer/; either resolves node_modules), or
 * `pnpm --filter @whm/relayer verify:hydration-fees`.
 *
 * Manual source mutants verified during the fix rounds (not re-run automatically, since both
 * mutate a checked-in file rather than an in-memory copy):
 *   - Round 1: comment out `fees: { estimateFeesPerGas: hydrationFees }` in `../src/chains.ts`,
 *     rerun this script. All three (A) scenarios go red (Hydration falls back to viem's default
 *     estimation, e.g. a nonzero priority fee on an RPC that reports none).
 *   - Round 2: change `block.baseFeePerGas * 2n` to `* 3n` in `../src/utils/fees.ts`, rerun. Both
 *     eip1559 (A) scenarios go red.
 */
import { getAddress, parseAbi, parseTransaction, type Hex } from "viem";
import { getGasPrice } from "viem/actions";

import { hydration } from "../src/chains";
import { hydrationClients, receiveMessage } from "../src/engine/hydration";

// Anvil/Hardhat's well-known default account #0 key. Public, funds-free, used only to sign a
// throwaway transaction that is never broadcast to a real chain.
const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

const CHAIN_ID = 222222; // HYDRATION_EVM_CHAIN_ID
const TO = getAddress("0x00000000000000000000000000000000000000bb");
const VAA_BYTES = Buffer.from("cafebabe", "hex");
const ABI = parseAbi(["function receiveMessage(bytes vaa) external"]);
const NONCE = 42;
const GAS = 200_000n;
const GAS_PRICE = 5_000_000_000n; // legacy branch and eth_gasPrice fallback
const PRIORITY_FEE = 1_000_000_000n; // when the RPC reports one

type Scenario = {
  name: string;
  baseFeePerGas: bigint | null;
  priorityFeeSupported: boolean;
};

const SCENARIOS: Scenario[] = [
  { name: "legacy", baseFeePerGas: null, priorityFeeSupported: false },
  { name: "eip1559-with-priority-rpc", baseFeePerGas: 1_000_000_000n, priorityFeeSupported: true },
  { name: "eip1559-no-priority-rpc", baseFeePerGas: 1_000_000_000n, priorityFeeSupported: false },
];

/**
 * Raw signed transactions captured from `galacticcouncil/whm` commit 12ddd6b (master, pre-#45),
 * running THAT commit's `hydrationClients()` + `receiveMessage()` against the exact fixture above
 * (same TEST_KEY / TO / ABI / VAA_BYTES / NONCE / GAS / GAS_PRICE / PRIORITY_FEE, one fresh client
 * per scenario, via the same fetch-mocking approach this file uses). Pinned as literal strings
 * rather than re-derived from the fee formula, so a change to that formula cannot make this
 * comparison pass by construction, and rather than fetched with `git show`, so this file keeps
 * working as `master` moves.
 */
const PINNED_RAW_TX: Record<string, Hex> = {
  legacy:
    "0xf8cd2a85012a05f20083030d409400000000000000000000000000000000000000bb80b864f953cec700000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000004cafebabe000000000000000000000000000000000000000000000000000000008306c83fa0ef5e3066c11ba691a3b6f67bc10ae16c1d8fabb19b4a61191cf7f8c8830d8ee5a019ef4c7715b0775cb9e08180101afbf40c49c98c1328c7fd63babb18e2a95e94",
  "eip1559-with-priority-rpc":
    "0x02f8d38303640e2a843b9aca0084b2d05e0083030d409400000000000000000000000000000000000000bb80b864f953cec700000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000004cafebabe00000000000000000000000000000000000000000000000000000000c001a090bf5181aaa4668c21bc81fb38425a6c9c61c754650de9eecc8becbbb62eccdca00878aebb7fe79a8d39320e04e0daa6be6c5232b7f5b7d691e76a5cd149b3962b",
  "eip1559-no-priority-rpc":
    "0x02f8cf8303640e2a80847735940083030d409400000000000000000000000000000000000000bb80b864f953cec700000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000004cafebabe00000000000000000000000000000000000000000000000000000000c001a061c6b1ec15dca25d4ca533a7b57e8401a3be15fc7301a63f453959b72e7a9d6da022a9c60ec09c3bbbbf8605c5adc037b78bfac37bdf387e3725f64a6a6b24fe64",
};

type JsonRpcRequest = { jsonrpc: "2.0"; id: number; method: string; params?: unknown[] };

/**
 * Installs a fetch mock answering the JSON-RPC calls a submission provokes. `feed` is read on
 * every call, not captured once, so a persistent client (section C) can have the block flip
 * between two submissions without reinstalling the mock.
 */
function installMock(feed: () => { baseFeePerGas: bigint | null; priorityFeeSupported: boolean }) {
  const original = globalThis.fetch;
  const capturedRaw: Hex[] = [];

  function answer(req: JsonRpcRequest): { jsonrpc: "2.0"; id: number; result?: unknown; error?: unknown } {
    const { id, method, params } = req;
    const scenario = feed();
    switch (method) {
      case "eth_chainId":
        return { jsonrpc: "2.0", id, result: `0x${CHAIN_ID.toString(16)}` };
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

/** Section C: one client, used for two submissions, with the block flipping in between,
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

  // A: pinned byte comparison, fresh client per scenario.
  for (const scenario of SCENARIOS) {
    const actual = await actualRawTx(scenario);
    const expected = PINNED_RAW_TX[scenario.name]!;
    record(actual === expected, scenario.name, () => {
      console.log(`  expected: ${expected}`);
      console.log(`  actual:   ${actual}`);
    });
  }

  // B: comparator sanity check. Corrupt the pinned expectation, confirm (A)'s comparison would
  // have gone red. Demonstrates only that the comparator can tell two transactions apart; the
  // mutants that matter are the source-level ones in the header and in section D below.
  {
    const scenario = SCENARIOS[1]!; // eip1559-with-priority-rpc
    const actual = await actualRawTx(scenario);
    const corruptedExpected = (PINNED_RAW_TX[scenario.name]!.slice(0, -1) + "0") as Hex;
    record(actual !== corruptedExpected, "comparator sanity check (corrupted pinned hex by one nibble)");
  }

  // C: the fix-round-2 defect, by construction. One client, block flips between submissions.
  {
    const legacyScenario = SCENARIOS[0]!;
    const eipScenario = SCENARIOS[1]!;

    const upgrade = await persistentClientFlip(legacyScenario, eipScenario);
    const tx1 = parseTransaction(upgrade.tx1);
    const tx2 = parseTransaction(await upgrade.secondCall());
    record(
      isWellFormed(tx1) && isWellFormed(tx2) && tx1.type === "legacy" && tx2.type === "legacy",
      "persistent client, legacy -> eip1559 block flip: stays a well-formed legacy tx",
      () => console.log("  tx1:", tx1, "\n  tx2:", tx2),
    );

    const downgrade = await persistentClientFlip(eipScenario, legacyScenario);
    let threw = false;
    try {
      await downgrade.secondCall();
    } catch {
      threw = true;
    }
    record(threw, "persistent client, eip1559 -> legacy block flip: throws instead of signing");
  }

  // D: source-perturbing mutant. Swaps the chain's fee hook in memory for the pre-fix, block-only
  // version and reruns (C)'s legacy -> eip1559 flip, showing that version produces a half-set
  // transaction where the fixed version does not.
  {
    const original = hydration.fees!.estimateFeesPerGas!;
    hydration.fees!.estimateFeesPerGas = async ({ block, client }) => {
      if (!block.baseFeePerGas) return { gasPrice: await getGasPrice(client) };
      return { maxFeePerGas: block.baseFeePerGas * 2n, maxPriorityFeePerGas: 0n };
    };

    let mutantCaught: boolean;
    let tx2: ReturnType<typeof parseTransaction> | undefined;
    try {
      const flip = await persistentClientFlip(SCENARIOS[0]!, SCENARIOS[1]!);
      tx2 = parseTransaction(await flip.secondCall());
      mutantCaught = !isWellFormed(tx2);
    } catch {
      // Also acceptable: the pre-fix hook can fail a different way under this harness.
      mutantCaught = true;
    } finally {
      hydration.fees!.estimateFeesPerGas = original;
    }
    record(mutantCaught, "source mutant (pre-fix block-only hook) makes the flip check go red", () =>
      console.log("  tx2 under the pre-fix hook:", tx2),
    );
  }

  if (failed) {
    console.error("\nverify-hydration-fees: FAILED");
    process.exit(1);
  }
  console.log("\nverify-hydration-fees: all checks passed");
}

main();
