/**
 * Runs the real `hydrationClients()` / `submit()` / `receiveMessage()` against real viem clients
 * with only `fetch` mocked, so ABI encoding, serialization and signing all execute.
 *
 *   A. Each Hydration fee scenario signs its pinned transaction.
 *   B. A corrupted pin does not compare equal.
 *   C. One long-lived client prices each submission off its own block across a base-fee flip.
 *   D. The same flip with no explicit fee fields: viem reuses its first transaction-type guess.
 *   E. Non-Hydration chains take viem's estimate: a plain chain signs its pinned EIP-1559 tx (E), a
 *      fee hook returning `{ gasPrice }` signs legacy (E2), a hook returning neither throws (E3).
 *
 * Run: pnpm --filter @whm/relayer verify:hydration-fees
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

// Anvil's public default account #0; signs only mocked transactions.
const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

const TO = getAddress("0x00000000000000000000000000000000000000bb");
const VAA_BYTES = Buffer.from("cafebabe", "hex");
const ABI = parseAbi(["function receiveMessage(bytes vaa) external"]);
const NONCE = 42;
const GAS = 200_000n;
const GAS_PRICE = 5_000_000_000n; // legacy branch and eth_gasPrice fallback
const PRIORITY_FEE = 1_000_000_000n; // when the RPC reports one

// viem's `base` with its RPCs stripped; the transport is mocked regardless.
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

/** Expected signed transaction per scenario under this mock. */
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
 * Answers a submission's JSON-RPC calls; `feed` is read per call so a test can flip the block.
 * Unknown methods get -32601, which also sends viem's eth_fillTransaction attempt down its
 * per-field path.
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

/** A `ChainClients` for any chain, built the way `hydrationClients` builds Hydration's. */
async function genericClients(chain: Chain): Promise<ChainClients> {
  const account = privateKeyToAccount(TEST_KEY);
  const publicClient = createPublicClient({ chain, transport: http("http://mock-rpc.invalid") });
  const wallet = createWalletClient({ account, chain, transport: http("http://mock-rpc.invalid") });
  return { account, publicClient, wallet };
}

/** Runs `submit()` on `chain`, returning the raw transaction sent or the error thrown. */
async function submitViaChain(
  chain: Chain,
  scenario: Scenario,
): Promise<{ raw?: Hex; error?: unknown }> {
  const mock = installMock(() => scenario);
  try {
    const clients = await genericClients(chain);
    await submit(
      clients,
      { to: TO, abi: ABI, functionName: "receiveMessage", args: [`0x${VAA_BYTES.toString("hex")}`] },
      NONCE,
    );
    return { raw: mock.rawTxs()[0] };
  } catch (error) {
    return { error };
  } finally {
    mock.restore();
  }
}

async function actualBaseRawTx(): Promise<Hex> {
  const { raw } = await submitViaChain(OFFLINE_BASE, BASE_SCENARIO);
  if (!raw) throw new Error("eth_sendRawTransaction was never called");
  return raw;
}

const HOOK_GAS_PRICE = 7_000_000_000n;

/** A chain whose own fee hook returns a legacy `{ gasPrice }`. */
const HOOK_GAS_PRICE_CHAIN: Chain = {
  id: 999_001,
  name: "HookReturnsGasPrice",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [] } },
  fees: { estimateFeesPerGas: async () => ({ gasPrice: HOOK_GAS_PRICE }) },
};

/** A chain whose fee hook returns neither shape; the cast is the point, viem does not check it. */
const HOOK_INVALID_CHAIN: Chain = {
  id: 999_002,
  name: "HookReturnsNeitherShape",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [] } },
  fees: { estimateFeesPerGas: async () => ({}) as never },
};

const HOOK_SCENARIO = (chainId: number): Scenario => ({
  name: `hook-${chainId}`,
  chainId,
  baseFeePerGas: 1_000_000_000n,
  priorityFeeSupported: true,
});

/** One long-lived client, two `receiveMessage` submissions, the block flipping in between. */
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

/** As `persistentClientFlip`, but writing directly with no fee fields, around `submit()`. */
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

/** True when a parsed transaction carries the fee fields its type requires. */
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

  // A: pinned bytes, fresh client per scenario.
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

  // B: a corrupted pin must not compare equal.
  {
    const scenario = SCENARIOS[1]!; // eip1559-with-priority-rpc
    const actual = await actualRawTx(scenario);
    const corruptedExpected = (PINNED_RAW_TX[scenario.name]!.slice(0, -1) + "0") as Hex;
    record(actual !== corruptedExpected, "comparator sanity check (corrupted pinned hex by one nibble)");
  }

  // C: one long-lived client across a base-fee flip, both directions.
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

  // D: the same flip, writing with no fee fields.
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

  // E: a plain non-Hydration chain signs its pinned EIP-1559 tx via viem's estimate.
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

  // E2: a fee hook returning { gasPrice } signs legacy with that gasPrice.
  {
    const { raw, error } = await submitViaChain(
      HOOK_GAS_PRICE_CHAIN,
      HOOK_SCENARIO(HOOK_GAS_PRICE_CHAIN.id),
    );
    const parsed = raw ? parseTransaction(raw) : undefined;
    const ok =
      !error &&
      !!parsed &&
      parsed.type === "legacy" &&
      (parsed as { gasPrice?: bigint }).gasPrice === HOOK_GAS_PRICE;
    record(
      ok,
      "chain hook returning { gasPrice }: submit() signs a legacy tx with that gasPrice, not a zero-fee eip1559 tx",
      () => console.log("  raw:", raw, "\n  error:", error, "\n  parsed:", parsed),
    );
  }

  // E3: a fee hook returning neither shape makes submit() throw chainFees's named error.
  {
    const { raw, error } = await submitViaChain(
      HOOK_INVALID_CHAIN,
      HOOK_SCENARIO(HOOK_INVALID_CHAIN.id),
    );
    const expectedMessage = `chainFees: ${HOOK_INVALID_CHAIN.name} returned no usable fee fields`;
    const threwNamedError = error instanceof Error && error.message === expectedMessage;
    record(
      !raw && threwNamedError,
      "chain hook returning neither shape: submit() throws chainFees's named error and sends nothing",
      () => console.log("  raw:", raw, "\n  error:", error, "\n  expected message:", expectedMessage),
    );
  }

  if (failed) {
    console.error("\nverify-hydration-fees: FAILED");
    process.exit(1);
  }
  console.log("\nverify-hydration-fees: all checks passed");
}

main();
