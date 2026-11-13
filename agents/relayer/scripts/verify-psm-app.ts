/**
 * The PSM relayer's route table, route wiring and boot guards, with only fetch mocked.
 *
 * Run: node --import tsx scripts/verify-psm-app.ts
 */
import { execFile, type ChildProcess } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createPublicClient,
  createWalletClient,
  encodeErrorResult,
  http,
  isAddress,
  pad,
  parseTransaction,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";

import { onEmitter } from "../src/engine/emitter";
import { baseClients } from "../src/clients/base";
import { hydrationClients, receiveMessage, type ChainClients } from "../src/clients/hydration";
import { createQueue } from "../src/engine/queue";
import { receiverAbi } from "../src/apps/psm/abi";
import { assertDestination, makeApp, wireRoutes, type ClientFactory } from "../src/apps/psm/app";
import { ROUTE_TABLE, routesFor, servedRoutes, type PsmRoute } from "../src/apps/psm/routes";
import { base as baseChain, WORMHOLE } from "../src/chains";
import logger from "../src/logger";
import type { Next, RelayerApp, RelayerCtx } from "../src/types";

const __dirname = dirname(fileURLToPath(import.meta.url));

const activeProbeFiles = new Set<string>();
const activeProbeChildren = new Set<ChildProcess>();
function cleanupProbeFiles(): void {
  for (const child of activeProbeChildren) child.kill("SIGKILL");
  activeProbeChildren.clear();
  for (const file of activeProbeFiles) rmSync(file, { force: true });
  activeProbeFiles.clear();
}
process.on("exit", cleanupProbeFiles);
process.on("SIGINT", () => {
  cleanupProbeFiles();
  process.exit(130);
});
process.on("SIGTERM", () => {
  cleanupProbeFiles();
  process.exit(143);
});

// Anvil's public default account #0; signs only mocked transactions.
const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const HYDRATION_CHAIN_ID = 222222;
const BASE_CHAIN_ID = 8453;

// Each corridor address is one route's emitter and the other's destination.
const VAULT = "0x1111111111111111111111111111111111111111" as Address;
const FACILITATOR = "0x2222222222222222222222222222222222222222" as Address;
const ADDR_C = "0x3333333333333333333333333333333333333333" as Address;
const ADDR_D = "0x4444444444444444444444444444444444444444" as Address;
const ADDR_E = "0x5555555555555555555555555555555555555555" as Address;

let failed = false;
function record(ok: boolean, label: string, detail?: () => void) {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${label}`);
  if (!ok) {
    detail?.();
    failed = true;
  }
}

function mintRoute(): PsmRoute {
  return {
    name: "mint",
    sourceChain: WORMHOLE.base,
    sourceEmitter: VAULT,
    destinationChain: WORMHOLE.hydration,
    destinationContract: FACILITATOR,
  };
}
function redeemRoute(): PsmRoute {
  return {
    name: "redeem",
    sourceChain: WORMHOLE.hydration,
    sourceEmitter: FACILITATOR,
    destinationChain: WORMHOLE.base,
    destinationContract: VAULT,
  };
}

// ─── Fetch mock (no network) ─────────────────────────────────────────────────────

type JsonRpcRequest = { jsonrpc: "2.0"; id: number; method: string; params?: unknown[] };

interface MockState {
  chainId: number;
  /** "replaced": another transaction's success receipt, as viem returns for a replaced delivery. */
  receipt: "success" | "reverted" | "replaced" | "absent";
  /** When set, `eth_call` reverts with this data instead of succeeding. */
  callRevert: Hex | undefined;
  /** Lowercased addresses that `eth_getCode` reports as having no code. */
  noCode: Set<string>;
  requests: string[];
}

function installMock() {
  const original = globalThis.fetch;
  const rawTxs: Hex[] = [];
  const state: MockState = {
    chainId: HYDRATION_CHAIN_ID,
    receipt: "success",
    callRevert: undefined,
    noCode: new Set(),
    requests: [],
  };

  function answer(req: JsonRpcRequest) {
    const { id, method, params } = req;
    state.requests.push(method);
    switch (method) {
      case "eth_chainId":
        return { jsonrpc: "2.0" as const, id, result: `0x${state.chainId.toString(16)}` };
      case "eth_call":
        return state.callRevert
          ? { jsonrpc: "2.0" as const, id, error: { code: 3, message: "execution reverted", data: state.callRevert } }
          : { jsonrpc: "2.0" as const, id, result: "0x" };
      case "eth_getCode":
        return {
          jsonrpc: "2.0" as const,
          id,
          result: state.noCode.has(String((params as [string])[0]).toLowerCase()) ? "0x" : "0x6001600155",
        };
      case "eth_estimateGas":
        return { jsonrpc: "2.0" as const, id, result: "0x30d40" }; // 200_000
      case "eth_getBlockByNumber":
        return { jsonrpc: "2.0" as const, id, result: { number: "0x1", baseFeePerGas: undefined } };
      case "eth_gasPrice":
        return { jsonrpc: "2.0" as const, id, result: "0x12a05f200" }; // 5 gwei
      case "eth_getBalance":
        return { jsonrpc: "2.0" as const, id, result: `0x${(10n ** 18n).toString(16)}` };
      case "eth_getTransactionCount":
        return { jsonrpc: "2.0" as const, id, result: "0x0" };
      case "eth_maxPriorityFeePerGas":
        return { jsonrpc: "2.0" as const, id, error: { code: -32601, message: "Method not found" } };
      case "eth_sendRawTransaction":
        rawTxs.push((params as [Hex])[0]);
        return { jsonrpc: "2.0" as const, id, result: `0x${"22".repeat(32)}` };
      case "eth_getTransactionReceipt":
        return {
          jsonrpc: "2.0" as const,
          id,
          result:
            state.receipt === "absent"
              ? null
              : {
                  blockHash: `0x${"ab".repeat(32)}`,
                  blockNumber: "0x2",
                  contractAddress: null,
                  cumulativeGasUsed: "0x5208",
                  effectiveGasPrice: "0x12a05f200",
                  from: `0x${"11".repeat(20)}`,
                  gasUsed: "0x5208",
                  logs: [],
                  logsBloom: `0x${"00".repeat(256)}`,
                  status: state.receipt === "reverted" ? "0x0" : "0x1",
                  to: `0x${"22".repeat(20)}`,
                  transactionHash: state.receipt === "replaced" ? `0x${"33".repeat(32)}` : (params as [Hex])[0],
                  transactionIndex: "0x0",
                  type: "0x2",
                },
        };
      default:
        return { jsonrpc: "2.0" as const, id, error: { code: -32601, message: `mock: unhandled ${method}` } };
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
    rawTxs,
    state,
  };
}

async function buildClients(): Promise<ChainClients> {
  return hydrationClients("http://mock-rpc.invalid", TEST_KEY);
}

// ─── Fixtures shaped like the producer ───────────────────────────────────────────

function fakeApp(): { app: RelayerApp; routers: Map<number, Record<string, unknown>> } {
  const routers = new Map<number, Record<string, unknown>>();
  const app = {
    chain(id: number) {
      if (!routers.has(id)) routers.set(id, {});
      return { _addressHandlers: routers.get(id)! };
    },
  } as unknown as RelayerApp;
  return { app, routers };
}

interface CapturedTask {
  label: string;
  submit: (nonce: number) => Promise<Hex>;
}

function fakeQueue(): { queue: { add(task: CapturedTask): Promise<void> }; tasks: CapturedTask[] } {
  const tasks: CapturedTask[] = [];
  return { queue: { add: async (task) => void tasks.push(task) }, tasks };
}

function emitterKey(addr: Address): string {
  return pad(addr, { size: 32 }).slice(2).toLowerCase();
}

function fakeCtx(sequence: bigint): RelayerCtx {
  return {
    vaa: {
      bytes: Buffer.from("cafebabe", "hex"),
      payload: Buffer.alloc(0),
      sequence,
      emitterChain: 0,
      emitterAddress: Buffer.alloc(32),
      timestamp: Math.floor(Date.now() / 1000),
    },
    sourceTxHash: "0xdeadbeef",
    logger,
  } as unknown as RelayerCtx;
}

async function invoke(
  routers: Map<number, Record<string, unknown>>,
  chain: number,
  emitter: Address,
  sequence: bigint,
): Promise<void> {
  const bucket = routers.get(chain);
  const handler = bucket?.[emitterKey(emitter)] as
    | ((ctx: RelayerCtx, next: Next) => Promise<void>)
    | undefined;
  if (!handler) throw new Error(`no handler registered for chain ${chain} / ${emitter}`);
  await handler(fakeCtx(sequence), () => {});
}

/** `routesFor` without the chain-id check: validates addresses on the served subset only. */
function routesForWithoutChainCheck(destinationChain: number, table: PsmRoute[]): PsmRoute[] {
  return table
    .filter((r) => r.destinationChain === destinationChain)
    .map((route) => {
      for (const field of ["sourceEmitter", "destinationContract"] as const) {
        if (!isAddress(route[field])) throw new Error(`without the chain check: blank or malformed ${field}`);
      }
      return route;
    });
}

/**
 * Runs `code` in a fresh process with `env`. The probe sits in scripts/ so its ../src imports
 * resolve; async execFile, not execFileSync, so the signal handlers above can run mid-probe.
 */
function runInSubprocess(code: string, env: Record<string, string>): Promise<string> {
  const file = join(__dirname, `.probe-${process.pid}-${Math.random().toString(36).slice(2)}.ts`);
  activeProbeFiles.add(file);
  writeFileSync(file, code);

  return new Promise<string>((resolve, reject) => {
    const child = execFile(
      "npx",
      ["tsx", file],
      { cwd: __dirname, env: { ...process.env, ...env }, encoding: "utf8" },
      (err, stdout) => {
        rmSync(file, { force: true });
        activeProbeFiles.delete(file);
        if (err) {
          reject(err);
          return;
        }
        // Native-binding warnings can precede the probe's JSON on stdout; it is always the last line.
        const lines = stdout.trim().split("\n");
        resolve(lines[lines.length - 1]!);
      },
    );
    activeProbeChildren.add(child);
    child.once("exit", () => activeProbeChildren.delete(child));
  });
}

/** What `run` is refused with; bounded, as a makeApp without its boot checks hangs in the engine. */
async function startupError(run: () => Promise<void>): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve("(not refused within 5 s)"), 5_000);
  });
  try {
    return await Promise.race([run().then(() => "(started)", (e: Error) => e.message), limit]);
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  // One mock for the whole run, as hydrationClients() calls getChainId() at build. rawTxs
  // accumulates; each check reads the entry it just caused.
  const mock = installMock();

  // ─── 1. Refuse-to-start ─────────────────────────────────────────────────────

  // 1a. routesFor validates the whole table before filtering, so every destination refuses on the
  // same first blank row, whatever state the table is in.
  function isBlank(r: PsmRoute): boolean {
    return (r.sourceEmitter as string) === "" || (r.destinationContract as string) === "";
  }

  function checkAdaptiveTableState(table: PsmRoute[], label: string): void {
    const mint = table.find((r) => r.name === "mint")!;
    const redeem = table.find((r) => r.name === "redeem")!;
    const firstBlank = table.find(isBlank);

    if (firstBlank) {
      for (const [chainLabel, destChain] of [
        ["hydration", WORMHOLE.hydration],
        ["base", WORMHOLE.base],
      ] as const) {
        let msg = "";
        try {
          routesFor(destChain, table);
        } catch (e) {
          msg = (e as Error).message;
        }
        record(
          msg.includes(`"${firstBlank.name}"`) && msg.includes("is not set"),
          `${label} (blank: "${firstBlank.name}") refuses to start for ${chainLabel}, naming "${firstBlank.name}" as blank`,
          () => console.log(`  message: ${msg || "(did not throw)"}`),
        );
      }
    } else {
      const hydRoutes = routesFor(WORMHOLE.hydration, table);
      record(
        hydRoutes.length === 1 && hydRoutes[0]!.name === "mint",
        `${label} (filled) serves exactly the mint route for hydration`,
      );
      const baseRoutes = routesFor(WORMHOLE.base, table);
      record(
        baseRoutes.length === 1 && baseRoutes[0]!.name === "redeem",
        `${label} (filled) serves exactly the redeem route for base`,
      );
      record(
        mint.destinationContract.toLowerCase() === redeem.sourceEmitter.toLowerCase() &&
          redeem.destinationContract.toLowerCase() === mint.sourceEmitter.toLowerCase(),
        `${label} (filled) satisfies corridor closure`,
      );
    }
  }

  checkAdaptiveTableState(ROUTE_TABLE, "shipped ROUTE_TABLE");
  record(ROUTE_TABLE.length === 2, "shipped ROUTE_TABLE carries exactly the two launch routes");

  const blankMint = { ...mintRoute(), sourceEmitter: "" as Address, destinationContract: "" as Address };
  const blankRedeem = { ...redeemRoute(), sourceEmitter: "" as Address, destinationContract: "" as Address };
  checkAdaptiveTableState([blankMint, blankRedeem], "synthetic table, fully blank");
  checkAdaptiveTableState([mintRoute(), blankRedeem], "synthetic table, mint filled / redeem blank");
  checkAdaptiveTableState([blankMint, redeemRoute()], "synthetic table, redeem filled / mint blank");
  checkAdaptiveTableState([mintRoute(), redeemRoute()], "synthetic table, fully filled");

  // 1b. A filled table in the shipped shape.
  {
    const filledShippedShape = [mintRoute(), redeemRoute()];
    const hyd = routesFor(WORMHOLE.hydration, filledShippedShape);
    const base = routesFor(WORMHOLE.base, filledShippedShape);
    record(
      hyd.length === 1 && hyd[0]!.name === "mint",
      "synthetic FILLED shipped-shape table: hydration destination serves exactly mint",
    );
    record(
      base.length === 1 && base[0]!.name === "redeem",
      "synthetic FILLED shipped-shape table: base destination serves exactly redeem",
    );
  }

  // 1c. One field at a time; blank and malformed are worded apart, as they have different fixes.
  function validRoute(): PsmRoute {
    return {
      name: "synthetic",
      sourceChain: WORMHOLE.base,
      sourceEmitter: VAULT,
      destinationChain: WORMHOLE.hydration,
      destinationContract: FACILITATOR,
    };
  }

  for (const field of ["sourceEmitter", "destinationContract"] as const) {
    const table = [validRoute()];

    let baselineOk = true;
    try {
      routesFor(WORMHOLE.hydration, table);
    } catch {
      baselineOk = false;
    }
    record(baselineOk, `refuse-to-start baseline: fully valid "${field}" route starts clean`);

    const original = table[0]![field];

    table[0]![field] = "" as Address;
    let blankMsg = "";
    try {
      routesFor(WORMHOLE.hydration, table);
    } catch (e) {
      blankMsg = (e as Error).message;
    }
    record(
      blankMsg.includes('"synthetic"') && blankMsg.includes(field) && blankMsg.includes("is not set") &&
        !blankMsg.includes("is not a valid address"),
      `refuse-to-start on blank ${field}, named, worded as "not set" (not "malformed")`,
      () => console.log(`  message: ${blankMsg || "(did not throw)"}`),
    );

    table[0]![field] = "0x1234" as Address;
    let malformedMsg = "";
    try {
      routesFor(WORMHOLE.hydration, table);
    } catch (e) {
      malformedMsg = (e as Error).message;
    }
    record(
      malformedMsg.includes('"synthetic"') && malformedMsg.includes(field) &&
        malformedMsg.includes("is not a valid address") && !malformedMsg.includes("is not set"),
      `refuse-to-start on malformed ${field}, named, worded as "not a valid address" (not "not set")`,
      () => console.log(`  message: ${malformedMsg || "(did not throw)"}`),
    );

    table[0]![field] = original;
    let restoredOk = true;
    try {
      routesFor(WORMHOLE.hydration, table);
    } catch {
      restoredOk = false;
    }
    record(restoredOk, `refuse-to-start: restoring ${field} starts clean again`);
  }

  // 1d. The zero address is a valid address, and a call to it succeeds, so it would pass every later
  // check and deliver nothing: each address field refuses it, named, in its own words.
  for (const field of ["sourceEmitter", "destinationContract"] as const) {
    const table = [validRoute()];
    table[0]![field] = zeroAddress;
    let msg = "";
    try {
      routesFor(WORMHOLE.hydration, table);
    } catch (e) {
      msg = (e as Error).message;
    }
    record(
      msg.includes('"synthetic"') && msg.includes(field) && msg.includes("zero address"),
      `refuse-to-start on a zero ${field}, named, worded as "the zero address"`,
      () => console.log(`  message: ${msg || "(did not throw)"}`),
    );
  }

  // ─── 2. Chain-id validation ─────────────────────────────────────────────────

  // 2a. A typo'd sourceChain on a served route.
  {
    const table = [validRoute()];

    let baselineOk = true;
    try {
      routesFor(WORMHOLE.hydration, table);
    } catch {
      baselineOk = false;
    }
    record(baselineOk, "chain-id baseline: a route with a real sourceChain (Base) starts clean");

    table[0]!.sourceChain = 3; // typo for 30 (Base)
    let msg = "";
    try {
      routesFor(WORMHOLE.hydration, table);
    } catch (e) {
      msg = (e as Error).message;
    }
    record(
      msg.includes('"synthetic"') && msg.includes("sourceChain") && msg.includes("3"),
      "refuse-to-start on a typo'd sourceChain (3 for 30), named with the bad value",
      () => console.log(`  message: ${msg || "(did not throw)"}`),
    );

    table[0]!.sourceChain = WORMHOLE.base;
    let restoredOk = true;
    try {
      routesFor(WORMHOLE.hydration, table);
    } catch {
      restoredOk = false;
    }
    record(restoredOk, "chain-id: restoring sourceChain to a real chain starts clean again");
  }

  // 2b. Without the chain-id check, a typo'd destinationChain silently drops its route and the
  // survivor starts.
  {
    const healthy = [mintRoute(), redeemRoute()];
    const corrupted = [mintRoute(), { ...redeemRoute(), destinationChain: 424_242 }];

    record(
      routesFor(WORMHOLE.hydration, healthy).length === 1 && routesFor(WORMHOLE.base, healthy).length === 1,
      "chain-id baseline: the healthy mint/redeem pair serves both destinations cleanly",
    );

    // Nothing asks for chain 424242, so redeem vanishes from both processes' filters.
    const servedWithoutCheck = routesForWithoutChainCheck(WORMHOLE.hydration, corrupted);
    record(
      servedWithoutCheck.length === 1 && servedWithoutCheck[0]!.name === "mint",
      "mutation sanity: a routesFor without the chain-id check silently drops the corrupted route and starts on the survivor",
    );

    let msg = "";
    try {
      routesFor(WORMHOLE.hydration, corrupted);
    } catch (e) {
      msg = (e as Error).message;
    }
    record(
      msg.includes('"redeem"') && msg.includes("destinationChain") && msg.includes("424242"),
      "destinationChain typo is caught and named instead of silently dropping the route",
      () => console.log(`  message: ${msg || "(did not throw)"}`),
    );

    let baseMsg = "";
    try {
      routesFor(WORMHOLE.base, corrupted);
    } catch (e) {
      baseMsg = (e as Error).message;
    }
    record(
      baseMsg.includes('"redeem"') && baseMsg.includes("destinationChain"),
      "the destinationChain typo also stops the OTHER destination's process, not just the one it would have matched",
      () => console.log(`  message: ${baseMsg || "(did not throw)"}`),
    );
  }

  // 2c. A destinationChain typo'd into its own sourceChain passes the id check: psm-base would
  // deliver the vault's mint messages to the facilitator's address on Base.
  {
    const typo = [{ ...mintRoute(), destinationChain: WORMHOLE.base }, redeemRoute()];
    for (const [chainLabel, chain] of [
      ["hydration", WORMHOLE.hydration],
      ["base", WORMHOLE.base],
    ] as const) {
      let msg = "";
      try {
        routesFor(chain, typo);
      } catch (e) {
        msg = (e as Error).message;
      }
      record(
        msg.includes('"mint"') && msg.includes("sourceChain and destinationChain are both 30"),
        `a route whose destinationChain typo'd into its own sourceChain is refused for ${chainLabel}, naming the route`,
        () => console.log(`  message: ${msg || "(did not throw)"}`),
      );
    }
  }

  // ─── 3. Corridor closure + duplicate-source guard ──────────────────────────

  // 3a. Closure, broken by pasting mint's two addresses into each other's column.
  {
    const table = [mintRoute(), redeemRoute()];
    let baselineOk = true;
    try {
      routesFor(WORMHOLE.hydration, table);
    } catch {
      baselineOk = false;
    }
    record(baselineOk, "closure baseline: the healthy mint/redeem pair closes cleanly");

    const originalMintEmitter = table[0]!.sourceEmitter;
    const originalMintContract = table[0]!.destinationContract;
    table[0]!.sourceEmitter = originalMintContract;
    table[0]!.destinationContract = originalMintEmitter;

    let msg = "";
    try {
      routesFor(WORMHOLE.hydration, table);
    } catch (e) {
      msg = (e as Error).message;
    }
    record(
      msg.includes('"mint"') && msg.includes('"redeem"') && msg.toLowerCase().includes("closure"),
      "closure broken by swapping mint's sourceEmitter/destinationContract, naming both routes",
      () => console.log(`  message: ${msg || "(did not throw)"}`),
    );

    table[0]!.sourceEmitter = originalMintEmitter;
    table[0]!.destinationContract = originalMintContract;
    let restoredOk = true;
    try {
      routesFor(WORMHOLE.hydration, table);
    } catch {
      restoredOk = false;
    }
    record(restoredOk, "closure: restoring mint's fields closes cleanly again");
  }

  // 3b. Known limit: closure is relative, so a consistent swap across both routes still closes.
  {
    const fullySwapped: PsmRoute[] = [
      { ...mintRoute(), sourceEmitter: FACILITATOR, destinationContract: VAULT },
      { ...redeemRoute(), sourceEmitter: VAULT, destinationContract: FACILITATOR },
    ];
    let closes = true;
    try {
      routesFor(WORMHOLE.hydration, fullySwapped);
    } catch {
      closes = false;
    }
    record(
      closes,
      "documented residual: swapping VAULT/FACILITATOR consistently across both routes still closes (deploy-time trust; see routes.ts)",
    );
  }

  // 3c. Two routes sharing (sourceChain, sourceEmitter): onEmitter would keep only the last one.
  {
    const distinct: PsmRoute[] = [
      { name: "dup-a", sourceChain: WORMHOLE.base, sourceEmitter: VAULT, destinationChain: WORMHOLE.hydration, destinationContract: ADDR_C },
      { name: "dup-b", sourceChain: WORMHOLE.base, sourceEmitter: ADDR_D, destinationChain: WORMHOLE.hydration, destinationContract: ADDR_C },
    ];
    let baselineOk = true;
    try {
      routesFor(WORMHOLE.hydration, distinct);
    } catch {
      baselineOk = false;
    }
    record(baselineOk, "duplicate-source baseline: two routes with distinct sourceEmitters both serve cleanly");

    const duplicated = distinct.map((r) => ({ ...r }));
    duplicated[1]!.sourceEmitter = VAULT; // now shares dup-a's (sourceChain, sourceEmitter)

    let msg = "";
    try {
      routesFor(WORMHOLE.hydration, duplicated);
    } catch (e) {
      msg = (e as Error).message;
    }
    record(
      msg.includes('"dup-a"') && msg.includes('"dup-b"'),
      "duplicate-source guard fires when two served routes share (sourceChain, sourceEmitter), naming both",
      () => console.log(`  message: ${msg || "(did not throw)"}`),
    );

    let restoredOk = true;
    try {
      routesFor(WORMHOLE.hydration, distinct);
    } catch {
      restoredOk = false;
    }
    record(restoredOk, "duplicate-source: distinct sourceEmitters (no mutation applied) still serve cleanly");
  }

  // 3d. A chain id typo'd into a third known chain leaves a route nothing mirrors: routesFor lets it
  // through, servedRoutes, which every process uses, refuses it.
  {
    const healthy = [mintRoute(), redeemRoute()];
    record(
      servedRoutes(WORMHOLE.hydration, healthy).length === 1 && servedRoutes(WORMHOLE.base, healthy).length === 1,
      "return-route baseline: the healthy mint/redeem pair is served by both destinations",
    );

    const typo = [mintRoute(), { ...redeemRoute(), sourceChain: WORMHOLE.ethereum }];
    let lenient = true;
    try {
      routesFor(WORMHOLE.hydration, typo);
    } catch {
      lenient = false;
    }
    record(lenient, "documented: routesFor alone accepts a route with no mirror (the typo to Ethereum passes it)");

    for (const [chainLabel, chain, route] of [
      ["hydration", WORMHOLE.hydration, "mint"],
      ["base", WORMHOLE.base, "redeem"],
    ] as const) {
      let msg = "";
      try {
        servedRoutes(chain, typo);
      } catch (e) {
        msg = (e as Error).message;
      }
      record(
        msg.includes(`"${route}"`) && msg.includes("no route runs back"),
        `servedRoutes refuses a served route with no return route for ${chainLabel}, naming "${route}"`,
        () => console.log(`  message: ${msg || "(did not throw)"}`),
      );
    }
  }

  // ─── 4. Destination-keying: no direction hardcoded ─────────────────────────

  const routeMint = mintRoute();
  const routeRedeem = redeemRoute();
  const bothDirections = [routeMint, routeRedeem];

  record(
    routesFor(WORMHOLE.hydration, bothDirections).length === 1 &&
      routesFor(WORMHOLE.hydration, bothDirections)[0] === routeMint,
    "routesFor(hydration) returns exactly the mint route",
  );
  record(
    routesFor(WORMHOLE.base, bothDirections).length === 1 &&
      routesFor(WORMHOLE.base, bothDirections)[0] === routeRedeem,
    "routesFor(base) returns exactly the redeem route",
  );

  const hydDest = fakeApp();
  const hydQueue = fakeQueue();
  const hydClients = await buildClients();
  wireRoutes(hydDest.app, routesFor(WORMHOLE.hydration, bothDirections), hydClients, hydQueue.queue as never);

  const baseDest = fakeApp();
  const baseQueue = fakeQueue();
  const baseClientsStandIn = await buildClients(); // app.ts never branches on the physical chain
  wireRoutes(baseDest.app, routesFor(WORMHOLE.base, bothDirections), baseClientsStandIn, baseQueue.queue as never);

  record(
    Object.keys(hydDest.routers.get(WORMHOLE.base) ?? {}).length === 1 &&
      emitterKey(VAULT) in (hydDest.routers.get(WORMHOLE.base) ?? {}),
    "hydration-destination process subscribes to the mint route's source (Base VAULT), nothing else",
  );
  record(
    !hydDest.routers.has(WORMHOLE.hydration),
    "hydration-destination process does not subscribe to its own destination chain as a source",
  );
  record(
    Object.keys(baseDest.routers.get(WORMHOLE.hydration) ?? {}).length === 1 &&
      emitterKey(FACILITATOR) in (baseDest.routers.get(WORMHOLE.hydration) ?? {}),
    "base-destination process subscribes to the redeem route's source (Hydration FACILITATOR), nothing else",
  );

  await invoke(hydDest.routers, WORMHOLE.base, VAULT, 1n);
  await invoke(baseDest.routers, WORMHOLE.hydration, FACILITATOR, 1n);
  record(hydQueue.tasks.length === 1, "mint VAA queued exactly once on the hydration-destination process");
  record(baseQueue.tasks.length === 1, "redeem VAA queued exactly once on the base-destination process");

  {
    await hydQueue.tasks[0]!.submit(1);
    const to = parseTransaction(mock.rawTxs[mock.rawTxs.length - 1]!).to;
    record(
      to?.toLowerCase() === FACILITATOR.toLowerCase(),
      "mint submission targets its own destinationContract (FACILITATOR), not the other route's",
    );
  }
  {
    await baseQueue.tasks[0]!.submit(1);
    const to = parseTransaction(mock.rawTxs[mock.rawTxs.length - 1]!).to;
    record(
      to?.toLowerCase() === VAULT.toLowerCase(),
      "redeem submission targets its own destinationContract (VAULT), not the other route's",
    );
  }

  function brokenWireRoutesHardcodesHydrationAsSource(
    app: RelayerApp,
    routes: PsmRoute[],
    clients: ChainClients,
    queue: { add(task: CapturedTask): Promise<void> },
  ): void {
    for (const route of routes) {
      onEmitter(app, WORMHOLE.hydration /* the mutant: ignores route.sourceChain */, route.sourceEmitter, (async (
        ctx: RelayerCtx,
        next: Next,
      ) => {
        await queue.add({
          label: route.name,
          submit: (n) => receiveMessage(clients, [] as never, route.destinationContract, ctx.vaa.bytes, n),
        });
        return next();
      }) as never);
    }
  }

  const broken = fakeApp();
  const brokenQueue = fakeQueue();
  brokenWireRoutesHardcodesHydrationAsSource(broken.app, bothDirections, hydClients, brokenQueue.queue);
  const mintUnderOwnChain = emitterKey(VAULT) in (broken.routers.get(WORMHOLE.base) ?? {});
  const redeemUnderOwnChain = emitterKey(FACILITATOR) in (broken.routers.get(WORMHOLE.hydration) ?? {});
  const bothMergedUnderHydration =
    emitterKey(VAULT) in (broken.routers.get(WORMHOLE.hydration) ?? {}) &&
    emitterKey(FACILITATOR) in (broken.routers.get(WORMHOLE.hydration) ?? {});
  record(
    !mintUnderOwnChain && bothMergedUnderHydration,
    "mutation sanity: the hardcoded-source variant DOES merge both routes under one chain (confirms the mutant is real)",
  );
  record(
    !(mintUnderOwnChain && redeemUnderOwnChain),
    "destination-keying check goes red on the hardcoded-source mutant (mint route not under its real source chain)",
  );

  // ─── 5. Second-route demonstration ─────────────────────────────────────────
  // An EVM source (Ethereum): a Solana emitter is not an H160.

  const routeFirst = mintRoute();
  const routeSecond: PsmRoute = {
    name: "second",
    sourceChain: WORMHOLE.ethereum,
    sourceEmitter: ADDR_E,
    destinationChain: WORMHOLE.hydration, // same destination as `routeFirst` — no new process
    destinationContract: ADDR_C,
  };

  const process_ = fakeApp();
  const processQueue = fakeQueue();
  const processClients = await buildClients();

  wireRoutes(process_.app, routesFor(WORMHOLE.hydration, [routeFirst]), processClients, processQueue.queue as never);
  const afterFirst = Object.keys(process_.routers.get(WORMHOLE.base) ?? {}).length;
  record(afterFirst === 1, "second-route baseline: one route landing on this destination registers one handler");

  wireRoutes(
    process_.app,
    routesFor(WORMHOLE.hydration, [routeFirst, routeSecond]),
    processClients,
    processQueue.queue as never,
  );
  const ethHandlers = Object.keys(process_.routers.get(WORMHOLE.ethereum) ?? {}).length;
  const baseHandlersStillThere = Object.keys(process_.routers.get(WORMHOLE.base) ?? {}).length;
  record(
    baseHandlersStillThere === 1 && ethHandlers === 1,
    "adding a second route (different EVM source chain, same destination) adds one handler and leaves the first untouched",
  );

  await invoke(process_.routers, WORMHOLE.base, VAULT, 2n);
  await invoke(process_.routers, WORMHOLE.ethereum, ADDR_E, 3n);
  record(
    processQueue.tasks.length === 2,
    "both routes on the shared destination submit through the same queue (one wallet, no new process)",
  );

  {
    await processQueue.tasks[0]!.submit(1);
    const to = parseTransaction(mock.rawTxs[mock.rawTxs.length - 1]!).to;
    record(to?.toLowerCase() === FACILITATOR.toLowerCase(), "first route still submits to its own destinationContract (FACILITATOR)");
  }
  {
    await processQueue.tasks[1]!.submit(1);
    const to = parseTransaction(mock.rawTxs[mock.rawTxs.length - 1]!).to;
    record(to?.toLowerCase() === ADDR_C.toLowerCase(), "second route submits to its own destinationContract (C)");
  }

  function brokenWireRoutesFirstOnly(
    app: RelayerApp,
    routes: PsmRoute[],
    clients: ChainClients,
    queue: { add(task: CapturedTask): Promise<void> },
  ): void {
    const route = routes[0];
    if (!route) return;
    onEmitter(app, route.sourceChain, route.sourceEmitter, (async (ctx: RelayerCtx, next: Next) => {
      await queue.add({
        label: route.name,
        submit: (n) => receiveMessage(clients, [] as never, route.destinationContract, ctx.vaa.bytes, n),
      });
      return next();
    }) as never);
  }

  const brokenProcess = fakeApp();
  const brokenProcessQueue = fakeQueue();
  brokenWireRoutesFirstOnly(
    brokenProcess.app,
    routesFor(WORMHOLE.hydration, [routeFirst, routeSecond]),
    processClients,
    brokenProcessQueue.queue,
  );
  const brokenEthHandlers = Object.keys(brokenProcess.routers.get(WORMHOLE.ethereum) ?? {}).length;
  record(
    brokenEthHandlers === 0,
    "mutation sanity: the first-route-only variant really does drop the second route (confirms the mutant is real)",
  );
  record(
    !(brokenEthHandlers === 1),
    "second-route check goes red on the first-route-only mutant (second route never registered)",
  );

  // ─── 6. makeApp: guards and key plumbing ───────────────────────────────────

  // makeApp reads ROUTE_TABLE itself, so it is set to the fixtures in place and restored after.
  {
    const originalMint = { ...ROUTE_TABLE[0]! };
    const originalRedeem = { ...ROUTE_TABLE[1]! };
    Object.assign(ROUTE_TABLE[0]!, mintRoute());
    Object.assign(ROUTE_TABLE[1]!, redeemRoute());
    try {
      // 6a. A destination with no route.
      let threw = false;
      let msg = "";
      try {
        await makeApp("psm-verify-unused", 999_999, hydrationClients, "http://mock-rpc.invalid", TEST_KEY);
      } catch (e) {
        threw = true;
        msg = (e as Error).message;
      }
      record(
        threw && msg.includes("999999"),
        "makeApp refuses to start when a destination chain has no configured route (against an otherwise-valid table)",
        () => console.log(`  message: ${msg || "(did not throw)"}`),
      );

      // 6b. Key forwarding; the spy throws right after capturing, before queue.init().
      let capturedKey: string | undefined;
      let capturedRpc: string | undefined;
      const spyFactory: ClientFactory = async (rpcUrl, key) => {
        capturedRpc = rpcUrl;
        capturedKey = key;
        throw new Error("STOP-AFTER-CAPTURE");
      };
      const testKey = "0xbaddecaf00000000000000000000000000000000000000000000000000ba" as `0x${string}`;
      let stoppedAsExpected = false;
      try {
        await makeApp("psm-verify-key-forward", WORMHOLE.hydration, spyFactory, "http://mock-rpc.invalid", testKey);
      } catch (e) {
        stoppedAsExpected = (e as Error).message === "STOP-AFTER-CAPTURE";
      }
      record(
        stoppedAsExpected && capturedKey === testKey && capturedRpc === "http://mock-rpc.invalid",
        "makeApp forwards its own key and rpcUrl arguments to clientFactory unchanged (no internal key resolution)",
      );

      // 6c. A destination contract with no code takes the call, mines, and spends gas for nothing
      // (a call to an address with no code succeeds), so it is refused at boot, naming the route.
      mock.state.noCode.add(FACILITATOR.toLowerCase());
      const noCodeMsg = await startupError(() =>
        makeApp("psm-verify-no-code", WORMHOLE.hydration, hydrationClients, "http://mock-rpc.invalid", TEST_KEY),
      );
      mock.state.noCode.clear();
      record(
        noCodeMsg.includes('"mint"') && noCodeMsg.includes(FACILITATOR) && noCodeMsg.includes("has no code"),
        "makeApp refuses to start when a served route's destination contract has no code, naming the route and the address",
        () => console.log(`  message: ${noCodeMsg || "(did not throw)"}`),
      );

      // 6d. One chain's client factory with the other's destination builds cleanly (each factory
      // checks only its own RPC) and would serve through the wrong wallet.
      mock.state.chainId = BASE_CHAIN_ID;
      const swapMsg = await startupError(() =>
        makeApp("psm-verify-swapped", WORMHOLE.hydration, baseClients, "http://mock-rpc.invalid", TEST_KEY),
      );
      mock.state.chainId = HYDRATION_CHAIN_ID;
      record(
        swapMsg.includes("destination chain 73") && swapMsg.includes("222222") && swapMsg.includes("8453"),
        "makeApp refuses Base's clients for the Hydration destination, naming both chains",
        () => console.log(`  message: ${swapMsg || "(did not throw)"}`),
      );
      const swapReverseMsg = await startupError(() =>
        makeApp("psm-verify-swapped-2", WORMHOLE.base, hydrationClients, "http://mock-rpc.invalid", TEST_KEY),
      );
      record(
        swapReverseMsg.includes("destination chain 30") && swapReverseMsg.includes("8453") && swapReverseMsg.includes("222222"),
        "makeApp refuses Hydration's clients for the Base destination, naming both chains",
        () => console.log(`  message: ${swapReverseMsg || "(did not throw)"}`),
      );

      // 6h. makeApp uses servedRoutes: redeem typo'd into a third chain leaves mint unmirrored.
      Object.assign(ROUTE_TABLE[1]!, { ...redeemRoute(), sourceChain: WORMHOLE.ethereum });
      const noReturnMsg = await startupError(() =>
        makeApp("psm-verify-no-return", WORMHOLE.hydration, hydrationClients, "http://mock-rpc.invalid", TEST_KEY),
      );
      Object.assign(ROUTE_TABLE[1]!, redeemRoute());
      record(
        noReturnMsg.includes('"mint"') && noReturnMsg.includes("no route runs back"),
        "makeApp refuses to start when a served route has no return route, naming it",
        () => console.log(`  message: ${noReturnMsg || "(did not throw)"}`),
      );
    } finally {
      Object.assign(ROUTE_TABLE[0]!, originalMint);
      Object.assign(ROUTE_TABLE[1]!, originalRedeem);
    }
  }

  // 6e-6g. `assertDestination` driven directly: the passing path of `makeApp` goes on to build the
  // engine app (Redis), so it cannot be run to completion here.
  {
    const pair = await buildClients();
    let passes = true;
    try {
      await assertDestination(WORMHOLE.hydration, [mintRoute()], pair);
    } catch {
      passes = false;
    }
    record(passes, "assertDestination passes for matching clients and a destination contract with code");

    // Wallet and public client on different chains, each way round: either half alone refuses.
    const mixed = {
      ...pair,
      wallet: createWalletClient({ account: pair.account, chain: baseChain, transport: http("http://mock-rpc.invalid") }),
    } as unknown as ChainClients;
    let mixedMsg = "";
    try {
      await assertDestination(WORMHOLE.hydration, [mintRoute()], mixed);
    } catch (e) {
      mixedMsg = (e as Error).message;
    }
    record(
      mixedMsg.includes("wallet is on chain 8453") && mixedMsg.includes("public client on chain 222222"),
      "assertDestination refuses a hand-built bundle whose wallet is on another chain than the destination's",
      () => console.log(`  message: ${mixedMsg || "(did not throw)"}`),
    );

    const mixedPublic = {
      ...pair,
      publicClient: createPublicClient({ chain: baseChain, transport: http("http://mock-rpc.invalid") }),
    } as unknown as ChainClients;
    let mixedPublicMsg = "";
    try {
      await assertDestination(WORMHOLE.hydration, [mintRoute()], mixedPublic);
    } catch (e) {
      mixedPublicMsg = (e as Error).message;
    }
    record(
      mixedPublicMsg.includes("wallet is on chain 222222") && mixedPublicMsg.includes("public client on chain 8453"),
      "assertDestination refuses a hand-built bundle whose public client is on another chain than the destination's",
      () => console.log(`  message: ${mixedPublicMsg || "(did not throw)"}`),
    );

    let unknownMsg = "";
    try {
      await assertDestination(WORMHOLE.ethereum, [mintRoute()], pair);
    } catch (e) {
      unknownMsg = (e as Error).message;
    }
    record(
      unknownMsg.includes("no EVM chain id is known") && unknownMsg.includes("destination chain 2"),
      "assertDestination refuses a destination chain with no known EVM chain id",
      () => console.log(`  message: ${unknownMsg || "(did not throw)"}`),
    );
  }

  // Composition: hydration.ts and base.ts boot on import, so their source is read instead.
  {
    const fs = await import("node:fs");
    // Comments may quote the names the checks forbid.
    const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const hydrationSrc = stripComments(
      fs.readFileSync(join(__dirname, "..", "src", "apps", "psm", "hydration.ts"), "utf8"),
    );
    const baseSrc = stripComments(fs.readFileSync(join(__dirname, "..", "src", "apps", "psm", "base.ts"), "utf8"));

    record(
      /\bprivateKey\(\)/.test(hydrationSrc) && !/\bprivateKeyBase\b/.test(hydrationSrc),
      "composition: hydration.ts's code calls privateKey(), never mentions privateKeyBase",
    );
    record(
      /\bprivateKeyBase\(\)/.test(baseSrc) && !/(?<!Base)\bprivateKey\(\)/.test(baseSrc),
      "composition: base.ts's code calls privateKeyBase(), never privateKey()",
    );

    // The key getters by their own names: `import { privateKey as privateKeyBase }` would make the
    // calls above read right while resolving PRIVKEY.
    const squash = (src: string) => src.replace(/\s+/g, " ");
    record(
      squash(baseSrc).includes('import { privateKeyBase } from "../../config";'),
      "composition: base.ts imports privateKeyBase from ../../config under its own name, and nothing else from it",
    );
    record(
      squash(hydrationSrc).includes('import { privateKey } from "../../config";'),
      "composition: hydration.ts imports privateKey from ../../config under its own name, and nothing else from it",
    );

    // The client factory by its own name from its own module (an alias would let one chain's
    // factory answer to the other's, and the call below would still read right).
    record(
      squash(baseSrc).includes('import { baseClients } from "../../clients/base";'),
      "composition: base.ts imports baseClients from ../../clients/base under its own name",
    );
    record(
      squash(hydrationSrc).includes('import { hydrationClients } from "../../clients/hydration";'),
      "composition: hydration.ts imports hydrationClients from ../../clients/hydration under its own name",
    );

    // makeApp is driven above with arguments chosen here, so only the entry's own text shows what it
    // hands makeApp.
    record(
      squash(baseSrc).includes(
        "makeApp(APP_NAME_BASE, WORMHOLE.base, baseClients, rpcBase(), key, FROM_SEQUENCE_FROM_HYDRATION)",
      ),
      "composition: base.ts hands makeApp Base's own namespace, destination, client factory, RPC and floors",
    );
    record(
      squash(hydrationSrc).includes(
        "makeApp(APP_NAME_HYDRATION, WORMHOLE.hydration, hydrationClients, RPC_HYDRATION, key, FROM_SEQUENCE_FROM_BASE)",
      ),
      "composition: hydration.ts hands makeApp Hydration's own namespace, destination, client factory, RPC and floors",
    );

    const checksRoutesFirst = (src: string, chain: string, getter: string) => {
      const at = src.indexOf(`servedRoutes(WORMHOLE.${chain})`);
      return at !== -1 && at < src.indexOf(`${getter}()`);
    };
    record(
      checksRoutesFirst(baseSrc, "base", "privateKeyBase"),
      "composition: base.ts checks servedRoutes(WORMHOLE.base) before it resolves its key",
    );
    record(
      checksRoutesFirst(hydrationSrc, "hydration", "privateKey"),
      "composition: hydration.ts checks servedRoutes(WORMHOLE.hydration) before it resolves its key",
    );
  }

  // ─── 7. APP_NAME: distinct env vars, no collapse ───────────────────────────
  // config.ts's opt() calls run at module load: one fresh process per env combination.

  {
    const probe = `
      import { APP_NAME_HYDRATION, APP_NAME_BASE } from "../src/apps/psm/config";
      console.log(JSON.stringify({ hydration: APP_NAME_HYDRATION, base: APP_NAME_BASE }));
    `;

    const defaults = JSON.parse(await runInSubprocess(probe, {}));
    record(
      defaults.hydration === "psm-hydration-relayer" &&
        defaults.base === "psm-base-relayer" &&
        defaults.hydration !== defaults.base,
      "APP_NAME: distinct defaults when nothing is set",
      () => console.log("  got:", defaults),
    );

    const onlyHydrationSet = JSON.parse(await runInSubprocess(probe, { APP_NAME_PSM_HYDRATION: "custom-hyd" }));
    record(
      onlyHydrationSet.hydration === "custom-hyd" && onlyHydrationSet.base === "psm-base-relayer",
      "APP_NAME: setting APP_NAME_PSM_HYDRATION alone does not affect APP_NAME_PSM_BASE's default (no collapse)",
      () => console.log("  got:", onlyHydrationSet),
    );

    const bothSet = JSON.parse(
      await runInSubprocess(probe, { APP_NAME_PSM_HYDRATION: "custom-hyd", APP_NAME_PSM_BASE: "custom-base" }),
    );
    record(
      bothSet.hydration === "custom-hyd" && bothSet.base === "custom-base" && bothSet.hydration !== bothSet.base,
      "APP_NAME: each process's own env var controls only its own namespace",
      () => console.log("  got:", bothSet),
    );

    const sharedNameProbe = `
      import { opt } from "../src/config";
      console.log(JSON.stringify({
        hydration: opt("APP_NAME", "psm-hydration-relayer"),
        base: opt("APP_NAME", "psm-base-relayer"),
      }));
    `;
    const sharedNameResult = JSON.parse(await runInSubprocess(sharedNameProbe, { APP_NAME: "collapsed" }));
    record(
      sharedNameResult.hydration === "collapsed" && sharedNameResult.base === "collapsed",
      "mutation sanity: two processes reading one APP_NAME really do collapse onto one value",
      () => console.log("  got:", sharedNameResult),
    );
  }

  // ─── 8. Receipts: a delivery that reverts on chain is handed back ───────────
  // The queue resolves once a transaction is broadcast, so only the handler's receipt read sees a
  // mined revert.
  {
    logger.silent = true;
    const clients = await buildClients();
    const realQueue = createQueue({
      publicClient: clients.publicClient,
      account: clients.account,
      warnMultiplier: 50n,
    });
    await realQueue.init();
    const dest = fakeApp();
    wireRoutes(dest.app, [mintRoute()], clients, realQueue);

    const receiptReads = () => mock.state.requests.filter((m) => m === "eth_getTransactionReceipt").length;
    async function run(sequence: bigint) {
      const handler = dest.routers.get(WORMHOLE.base)![emitterKey(VAULT)] as (
        ctx: RelayerCtx,
        next: Next,
      ) => Promise<void>;
      const sentBefore = mock.rawTxs.length;
      const readsBefore = receiptReads();
      let nexted = 0;
      let error: unknown;
      try {
        await handler(fakeCtx(sequence), () => {
          nexted++;
        });
      } catch (e) {
        error = e;
      }
      return { error, nexted, sent: mock.rawTxs.length - sentBefore, reads: receiptReads() - readsBefore };
    }

    mock.state.receipt = "success";
    const landed = await run(10n);
    record(
      landed.error === undefined && landed.nexted === 1 && landed.sent === 1 && landed.reads === 1,
      "receipt: a delivery that lands resolves the handler, after one broadcast and one receipt read",
      () => console.log("  ", landed),
    );

    mock.state.receipt = "reverted";
    const reverted = await run(11n);
    const revertedMsg = reverted.error instanceof Error ? reverted.error.message : "";
    record(
      reverted.sent === 1 &&
        reverted.nexted === 0 &&
        revertedMsg.includes("mint") &&
        revertedMsg.includes("reverted on chain"),
      "receipt: a delivery that mines and reverts rejects the handler for a retry, naming the route, and never calls next()",
      () => console.log("  ", { ...reverted, message: revertedMsg || "(did not throw)" }),
    );

    // viem returns a replacement's success receipt, so the handler checks whose it is. The mock serves
    // it for the original hash, which tests that comparison, not viem's replacement detection.
    mock.state.receipt = "replaced";
    const replaced = await run(13n);
    const replacedMsg = replaced.error instanceof Error ? replaced.error.message : "";
    record(
      replaced.sent === 1 &&
        replaced.nexted === 0 &&
        replacedMsg.includes("mint") &&
        replacedMsg.includes("was replaced by") &&
        replacedMsg.includes("33".repeat(32)),
      "receipt: a delivery whose receipt is for another transaction (a replacement) rejects the handler for a retry, naming the route",
      () => console.log("  ", { ...replaced, message: replacedMsg || "(did not throw)" }),
    );

    mock.state.receipt = "success";
    mock.state.callRevert = encodeErrorResult({
      abi: receiverAbi,
      errorName: "MessageAlreadyProcessed",
      args: [12n],
    });
    const done = await run(12n);
    record(
      done.error === undefined && done.nexted === 1 && done.sent === 0 && done.reads === 0,
      "receipt: a delivery that is already done sends nothing, reads no receipt, and resolves",
      () => console.log("  ", done),
    );
    mock.state.callRevert = undefined;

    const retried = await run(11n);
    record(
      retried.error === undefined && retried.nexted === 1 && retried.sent === 1,
      "receipt: the retry of the job that reverted simulates again and lands",
      () => console.log("  ", retried),
    );
    logger.silent = false;
  }

  mock.restore();

  if (failed) {
    console.error("\nverify-psm-app: FAILED");
    process.exit(1);
  }
  console.log("\nverify-psm-app: all checks passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
