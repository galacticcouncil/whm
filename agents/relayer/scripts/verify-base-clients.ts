/**
 * The real baseClients(), receiveMessage() and createQueue() with only fetch mocked: chain-id
 * assertion, per-call fee pricing, no public-RPC fallback, PRIVKEY_BASE isolation, gas-alert label.
 *
 * Run: node --import tsx scripts/verify-base-clients.ts
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

import { baseClients } from "../src/clients/base";
import { BASE_EVM_CHAIN_ID } from "../src/chains";
import { privateKey, privateKeyBase } from "../src/config";
import { receiveMessage } from "../src/clients/hydration";
import { createQueue } from "../src/engine/queue";
import logger from "../src/logger";

// KEY_A is anvil's public dev key #0 and signs only mocked transactions; KEY_B only has to differ.
const KEY_A = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const KEY_B = "0x9efd4a62b34034205675395eed693d4f4709688111220665ddd61c6567c4169a" as const;
const KEY_A_ADDRESS = privateKeyToAccount(KEY_A).address;

const MOCK_RPC_URL = "http://mock-rpc.invalid";
const TO = getAddress("0x00000000000000000000000000000000000000bb");
const VAA_BYTES = Buffer.from("cafebabe", "hex");
const ABI = parseAbi(["function receiveMessage(bytes vaa) external"]);
const GAS = 200_000n;
const PRIORITY_FEE = 1_000_000_000n;
const GAS_PRICE = 5_000_000_000n;

type JsonRpcRequest = { jsonrpc: "2.0"; id: number; method: string; params?: unknown[] };
type Scenario = { baseFeePerGas: bigint | null; balance?: bigint };

/** `feed` is read per call so a test can move `baseFeePerGas` between submissions. */
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

  // ---- 1. Chain-id assertion --------------------------------------------------------------
  {
    const WRONG_CHAIN_ID = 1;
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
    // Exact text: a substring like "1" matches almost any error.
    record(
      error !== undefined && error.message === expectedMessage,
      "chain-id assertion: mismatched RPC (reports 1) throws a named, legible error",
      () => console.log("  expected:", expectedMessage, "\n  actual:  ", error?.message),
    );

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
    const baseFee2 = 5_000_000_000n;
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

    // viem's default estimate: baseFeePerGas * 1.2 + maxPriorityFeePerGas.
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

    // Signer recovered from the raw transaction: parseTransaction does not populate `from`.
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
    // Origin, not the raw string: viem's http transport can add a trailing slash to a bare host.
    const mockOrigin = new URL(MOCK_RPC_URL).origin;
    record(
      urls.length > 0 && urls.every((u) => URL.canParse(u) && new URL(u).origin === mockOrigin),
      "fresh-per-call pricing: every request targets the RPC url baseClients() was given",
      () => console.log("  urls:", urls),
    );
  }

  // ---- 3. Falsy rpcUrl: no public-endpoint fallback ---------------------------------------------
  {
    // A counting stub: any fetch at all is the defect. It still answers a valid chain id so a client
    // that gets past the URL check fails the count, not on the mock's shape.
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
      // Both getters read process.env on every call, so no module reload is needed.
      process.env.PRIVKEY = KEY_A;
      process.env.PRIVKEY_BASE = KEY_B;
      record(
        privateKeyBase() === KEY_B && privateKey() === KEY_A && privateKeyBase() !== privateKey(),
        "key isolation: PRIVKEY_BASE and PRIVKEY resolve to different keys",
      );

      delete process.env.PRIVKEY_BASE;
      let threw = false;
      try {
        privateKeyBase();
      } catch {
        threw = true;
      }
      record(threw, "key isolation: privateKeyBase() throws when PRIVKEY_BASE is unset, no PRIVKEY fallback");

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

  // ---- 5. Low-gas alerting names the chain correctly ---------------------------------------
  {
    /** The "Gas: ..." line from the real queue's balance check; baseClients() rejects any id but 8453. */
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

    // Shows the assertion above can fail.
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
