/**
 * Reproduction for issue #45 (relayer: chain-parameterise the VAA submission helper) and its fix
 * round: a Hydration submission through `receiveMessage()` must sign the exact transaction
 * Hydration's fee rules require, across the legacy branch and both EIP-1559 branches (RPC answers
 * `eth_maxPriorityFeePerGas`, and RPC omits it).
 *
 * This runs the REAL `hydrationClients()` + `receiveMessage()` from `../src/engine/hydration`
 * against REAL viem clients, with only the HTTP transport mocked (`globalThis.fetch` intercepted,
 * not the viem client objects), so the actual signing path runs: real ABI encoding, a real local
 * account (`viem/accounts`), real RLP/EIP-1559 serialization and signature. The "expected" raw
 * transaction for each scenario is built independently, by hand, from Hydration's fee rule restated
 * directly rather than by calling any of the source under test, then compared byte-for-byte against
 * what the real code actually signs and sent via `eth_sendRawTransaction`.
 *
 * Ends with a mutation check: deliberately corrupts the independent expectation and confirms the
 * comparison goes red, then restores it, so a clean run here is evidence the comparison itself can
 * fail rather than a vacuous "always true" one.
 *
 * Run with: npx tsx agents/relayer/scripts/verify-hydration-fees.ts
 * (from the repo root, or from agents/relayer/; either resolves node_modules)
 */
import { encodeFunctionData, getAddress, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

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

type JsonRpcRequest = { jsonrpc: "2.0"; id: number; method: string; params?: unknown[] };

/** Installs a fetch mock answering only the JSON-RPC calls this scenario should provoke. Returns
 * the restore function plus the raw signed transaction captured off eth_sendRawTransaction. */
function installMock(scenario: Scenario) {
  const original = globalThis.fetch;
  let capturedRaw: Hex | undefined;

  function answer(req: JsonRpcRequest): { jsonrpc: "2.0"; id: number; result?: unknown; error?: unknown } {
    const { id, method, params } = req;
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
        capturedRaw = (params as [Hex])[0];
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
    rawTx: () => capturedRaw,
  };
}

/** The independent reconstruction: Hydration's fee rule restated by hand (no import from
 * `utils/fees.ts`), signed locally, never sent anywhere. */
async function expectedRawTx(scenario: Scenario): Promise<Hex> {
  const account = privateKeyToAccount(TEST_KEY);
  const data = encodeFunctionData({ abi: ABI, functionName: "receiveMessage", args: [`0x${VAA_BYTES.toString("hex")}`] });

  const feeFields =
    scenario.baseFeePerGas === null
      ? { gasPrice: GAS_PRICE }
      : (() => {
          const maxPriorityFeePerGas = scenario.priorityFeeSupported ? PRIORITY_FEE : 0n;
          return {
            maxFeePerGas: scenario.baseFeePerGas * 2n + maxPriorityFeePerGas,
            maxPriorityFeePerGas,
          };
        })();

  return account.signTransaction({
    to: TO,
    data,
    nonce: NONCE,
    chainId: CHAIN_ID,
    gas: GAS,
    ...feeFields,
  });
}

async function actualRawTx(scenario: Scenario): Promise<Hex> {
  const mock = installMock(scenario);
  try {
    const clients = await hydrationClients("http://mock-rpc.invalid", TEST_KEY);
    await receiveMessage(clients, ABI, TO, VAA_BYTES, NONCE);
    const raw = mock.rawTx();
    if (!raw) throw new Error("eth_sendRawTransaction was never called");
    return raw;
  } finally {
    mock.restore();
  }
}

async function main() {
  let failed = false;

  for (const scenario of SCENARIOS) {
    const [expected, actual] = await Promise.all([expectedRawTx(scenario), actualRawTx(scenario)]);
    const ok = expected === actual;
    console.log(`[${ok ? "PASS" : "FAIL"}] ${scenario.name}`);
    if (!ok) {
      console.log(`  expected: ${expected}`);
      console.log(`  actual:   ${actual}`);
      failed = true;
    }
  }

  // Mutation check: prove the comparison is not vacuous by corrupting the independent
  // reconstruction and confirming it now disagrees with the real code.
  const mutationScenario = SCENARIOS[1]!; // eip1559-with-priority-rpc
  const corrupted: Scenario = { ...mutationScenario, baseFeePerGas: mutationScenario.baseFeePerGas! + 1n };
  const [mutatedExpected, realActual] = await Promise.all([
    expectedRawTx(corrupted),
    actualRawTx(mutationScenario),
  ]);
  const mutationCaught = mutatedExpected !== realActual;
  console.log(`[${mutationCaught ? "PASS" : "FAIL"}] mutation check (corrupted baseFeePerGas by +1 wei)`);
  if (!mutationCaught) {
    console.log("  the comparison did not go red on a deliberately wrong expectation");
    failed = true;
  }

  if (failed) {
    console.error("\nverify-hydration-fees: FAILED");
    process.exit(1);
  }
  console.log("\nverify-hydration-fees: all scenarios matched, and the mutation check caught a wrong one");
}

main();
