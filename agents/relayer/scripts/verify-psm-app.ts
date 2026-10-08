/**
 * Verification harness for the PSM relayer scaffold, no network.
 *
 * Scope: this is the app-shape and route-table scaffold only, not a chain-mechanics check —
 * `verify-hydration-fees.ts` and `verify-base-clients.ts` already exhaustively cover per-chain
 * fee-shape correctness and key isolation. Every `ChainClients` object below is built with the real
 * `hydrationClients()` against a mocked transport — even where it stands in for "the other side" of
 * a route — because the property under test in most sections is that `apps/psm/app.ts` never
 * branches on which physical chain a route's `destinationChain` happens to be: it only ever reads
 * that field off the route.
 *
 * It also covers: distinct `APP_NAME` env vars per process (checked by spawning real
 * subprocesses — module-level `opt()` calls cannot be re-probed in-process); chain-id
 * validation, including the destination-chain-typo silent-drop case, reproduced against a
 * reimplementation without the chain-id check so the failure it prevents is evidence, not assertion;
 * the corridor closure invariant and the duplicate-source guard; an adaptive shipped-table check
 * that stays green across the address fill (plus a synthetic filled table exercised today); Base's
 * key isolation (composition check on the entry files, plus a functional proof that `makeApp`
 * forwards whatever key it is given rather than resolving one itself); and an EVM-only second-route
 * fixture (a Solana source with an H160 emitter cannot exist, so the second route uses an EVM one).
 *
 * Run with: pnpm --filter @whm/relayer verify:psm-app
 * (or `npx tsx agents/relayer/scripts/verify-psm-app.ts` from the repo root).
 */
import { execFile, type ChildProcess } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
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
import { baseClients } from "../src/engine/base";
import { hydrationClients, receiveMessage, type ChainClients } from "../src/engine/hydration";
import { createQueue } from "../src/engine/queue";
import { receiverAbi } from "../src/apps/psm/abi";
import { assertDestination, makeApp, wireRoutes, type ClientFactory } from "../src/apps/psm/app";
import { ROUTE_TABLE, routesFor, servedRoutes, type PsmRoute } from "../src/apps/psm/routes";
import { base as baseChain, WORMHOLE } from "../src/chains";
import logger from "../src/logger";
import type { Next, RelayerApp, RelayerCtx } from "../src/types";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Safety net for `runInSubprocess`'s temp files: a `finally` around a BLOCKING child-process call
// cannot run mid-interruption — constructed proof in `runInSubprocess`'s own doc comment — so this
// tracks every probe file (and its still-running child, if any) from the moment each is created,
// and a SIGINT/SIGTERM handler kills the child and removes the file explicitly before exiting.
// This only works BECAUSE `runInSubprocess` uses the async `execFile`: the event loop stays live
// while a probe runs, so these handlers get a chance to run in the first place. `process.on("exit",
// ...)` additionally covers normal and thrown-exception exits (already handled by `runInSubprocess`
// itself, but harmless and cheap to repeat here).
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

// Anvil/Hardhat's well-known default account #0 key. Public, funds-free — see
// verify-hydration-fees.ts, which uses the same key the same way.
const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const HYDRATION_CHAIN_ID = 222222;
const BASE_CHAIN_ID = 8453;

// VAULT and FACILITATOR are the two real corridor contracts — the same address plays both an
// emitter role and a destination-contract role, on its own chain, across the two routes. Fixtures
// that are meant to represent a healthy corridor reuse these two consistently; fixtures that are
// meant to violate closure deliberately do not.
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
// Same technique as verify-hydration-fees.ts: only globalThis.fetch is intercepted, so
// hydrationClients()/receiveMessage() run for real — real ABI encoding, real signing.

type JsonRpcRequest = { jsonrpc: "2.0"; id: number; method: string; params?: unknown[] };

/** What the mock answers. A scenario changes it between calls; `requests` records what was asked. */
interface MockState {
  /** Answer to `eth_chainId`. */
  chainId: number;
  /** What `eth_getTransactionReceipt` serves: a mined success, a mined revert, or nothing yet. */
  receipt: "success" | "reverted" | "absent";
  /** When set, `eth_call` reverts with this data instead of succeeding. */
  callRevert: Hex | undefined;
  /** Lowercased addresses that `eth_getCode` reports as having no code. */
  noCode: Set<string>;
  /** Every method requested, in order. */
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
                  status: state.receipt === "success" ? "0x1" : "0x0",
                  to: `0x${"22".repeat(20)}`,
                  transactionHash: (params as [Hex])[0],
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
// One process = one persistent `app` + one persistent `queue` + one client set for the process
// lifetime, exactly as `makeApp` builds them once and `wireRoutes` is called against them —
// never a fresh app/queue/clients per route or per scenario.

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

/**
 * A `routesFor` without the chain-id check: it filters and validates addresses on the SERVED subset
 * only. Used once, below, to reproduce — not assert — that a typo'd `destinationChain` then vanishes
 * silently instead of refusing to start.
 */
function legacyRoutesForNoChainCheck(destinationChain: number, table: PsmRoute[]): PsmRoute[] {
  return table
    .filter((r) => r.destinationChain === destinationChain)
    .map((route) => {
      for (const field of ["sourceEmitter", "destinationContract"] as const) {
        if (!isAddress(route[field])) throw new Error(`legacy: blank/malformed ${field}`);
      }
      return route;
    });
}

/**
 * Run a short snippet against the real relayer source, in a fresh process with `env` applied —
 * needed for the APP_NAME check, since `config.ts`'s `opt()` calls run once at module load and
 * cannot be re-probed by re-importing within this same process.
 *
 * The probe file is written INSIDE `scripts/`, not a system tmpdir, so its own `../src/...`
 * relative imports resolve exactly the way this script's do — a tmpdir sibling would need a
 * different relative path (or a node_modules symlink) to reach the same source. Removed again
 * immediately after, success or failure.
 *
 * Uses the ASYNC `execFile`, not `execFileSync`, and that is load-bearing, not a style choice:
 * `execFileSync` blocks the whole JS thread, including its own event loop's signal watcher, until
 * the child exits — constructed proof (a throwaway script: a `process.on("SIGINT")` handler next
 * to an `execFileSync("sleep", ["5"])`) showed the handler simply never runs while blocked, no
 * matter how the call is wrapped in `try`/`finally`. `execFile`'s promise keeps the event loop
 * live, so `activeProbeFiles`'s SIGINT/SIGTERM handlers (above) can actually run DURING a probe's
 * execution, kill the still-running child, and remove the file — not just after it would have
 * exited on its own.
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
        // Native-binding warnings (secp256k1/bigint fallbacks) land on stdout, ahead of the
        // probe's own JSON line — the same noise this script's own runs print. The probe always
        // logs exactly one JSON object as its last line, so take that rather than the whole
        // stream.
        const lines = stdout.trim().split("\n");
        resolve(lines[lines.length - 1]!);
      },
    );
    // Tracked so a SIGINT/SIGTERM mid-probe can kill this specific child rather than leaving it
    // (and the file it's reading) orphaned when the handler calls process.exit().
    activeProbeChildren.add(child);
    child.once("exit", () => activeProbeChildren.delete(child));
  });
}

/**
 * What `run` is refused with, or why it was not: a `makeApp` whose boot checks are gone does not
 * reject, it goes on to the engine and hangs there, so the wait is bounded and a start that was not
 * refused reads as a failed check rather than as a stuck script.
 */
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
  // One mock, installed for the whole run: `hydrationClients()` itself calls `getChainId()` over
  // the transport, so the mock has to be live before the very first client is built, not just
  // around each `submit()` call. `rawTxs` accumulates across every submission below; each check
  // reads the entry it just caused, by index, rather than resetting the mock per section.
  const mock = installMock();

  // ─── 1. Refuse-to-start ─────────────────────────────────────────────────────

  // 1a. The shipped table is blank on purpose — both PSM addresses are unknown until the
  // migration runs. `routesFor` validates the WHOLE table before filtering (see its own doc
  // comment), so every process reports the SAME first invalid row in table order regardless of
  // which destination it asks for — the corridor is one shared unit and both processes refuse
  // together while any row of it is bad. This check is written to stay meaningful across the
  // address fill: it asks "which state is the table actually in" and asserts the right thing for
  // that state, rather than hardcoding "it must be blank" (see section 1b below for the dedicated
  // blank-vs-filled coverage).
  //
  // The branch predicate (`isBlank(mint) || isBlank(redeem)`) is table-wide, so asserting `"mint"`
  // inside the blank branch would be correct only by coincidence: mint happens to be first in
  // table order, and the shipped table is either fully blank or (eventually) fully filled.
  // Half-filled (mint filled, redeem still blank) is a real intermediate deploy state — nothing
  // stops an operator filling one contract's address before the other's migration step runs — and
  // under it `routesFor` correctly names "redeem" as the blank one, which a hardcoded `"mint"`
  // would contradict. So the check asserts against the actual FIRST blank route in table order,
  // whatever its name is.
  function isBlank(r: PsmRoute): boolean {
    return (r.sourceEmitter as string) === "" || (r.destinationContract as string) === "";
  }

  /**
   * The adaptive shipped-table check: asserts the right thing for whichever state `table` is
   * actually in. Exercised against the real `ROUTE_TABLE` below, and against four synthetic states
   * covering both half-filled orientations plus the fully-blank and fully-filled ends, none of which
   * depend on `ROUTE_TABLE`'s real (currently fully-blank) state.
   */
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

  // The four states, independent of ROUTE_TABLE's real state: the check holds for each of them, not
  // only for the live table's current (fully-blank) case.
  const blankMint = { ...mintRoute(), sourceEmitter: "" as Address, destinationContract: "" as Address };
  const blankRedeem = { ...redeemRoute(), sourceEmitter: "" as Address, destinationContract: "" as Address };
  checkAdaptiveTableState([blankMint, blankRedeem], "synthetic table, fully blank");
  checkAdaptiveTableState([mintRoute(), blankRedeem], "synthetic table, mint filled / redeem blank");
  checkAdaptiveTableState([blankMint, redeemRoute()], "synthetic table, redeem filled / mint blank");
  checkAdaptiveTableState([mintRoute(), redeemRoute()], "synthetic table, fully filled");

  // 1b. Dedicated synthetic filled table, in the shipped shape (same names, same chains),
  // exercised today regardless of ROUTE_TABLE's real state — required so this logic path is
  // proven working now, not just "ready" for whenever the address fill lands.
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

  // 1c. Field isolation + mutation: a fully valid synthetic route passes; blanking or
  // malforming exactly one field fails, naming exactly that field (and distinguishing "blank" from
  // "malformed" in the message — they have different fixes); restoring it passes again.
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

  // 2a. A typo'd sourceChain on a route that IS served: caught, named, with the bad value.
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

  // 2b. Without the chain-id check, a typo'd destinationChain silently drops the route and lets the
  // survivor start. Reproduce that against a reimplementation without the check, then show the real
  // routesFor refuses instead.
  {
    const healthy = [mintRoute(), redeemRoute()];
    const corrupted = [mintRoute(), { ...redeemRoute(), destinationChain: 424_242 }];

    // Sanity: the healthy pair (real closure, real chain ids) starts clean on both destinations.
    record(
      routesFor(WORMHOLE.hydration, healthy).length === 1 && routesFor(WORMHOLE.base, healthy).length === 1,
      "chain-id baseline: the healthy mint/redeem pair serves both destinations cleanly",
    );

    // Reproduce the failure the check prevents: a routesFor with no chain-id pre-pass never even
    // looks at "redeem"'s destinationChain unless something asks for chain 424242 — which nothing
    // ever does — so the route vanishes from both processes' filters, and the survivor (mint) looks
    // like a complete, healthy 1-route table.
    const legacyServed = legacyRoutesForNoChainCheck(WORMHOLE.hydration, corrupted);
    record(
      legacyServed.length === 1 && legacyServed[0]!.name === "mint",
      "mutation sanity: the pre-fix routesFor (no chain-id check) really did silently drop the corrupted route and start on the survivor",
    );

    // The real routesFor refuses instead, naming the corrupted route and field.
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

    // And critically, the OTHER process (base) also refuses — not just the one whose filter would
    // have matched the corrupted row — because the whole table is validated up front.
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

  // 2c. A route from a chain to itself. A destinationChain that typo'd into another KNOWN id is
  // valid by the check above, has no mirror to close against, and serves the wrong route from the
  // wrong process (psm-base would deliver the vault's mint messages to the facilitator's address on
  // Base). Refused for both destinations, because the whole table is validated up front.
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

  // 3a. Closure: the healthy pair passes; swapping mint's emitter/contract (a plausible real
  // mistake — pasting the two addresses into each other's column) breaks it, named; restoring
  // passes again.
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
    table[0]!.sourceEmitter = originalMintContract; // swapped
    table[0]!.destinationContract = originalMintEmitter; // swapped

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

  // 3b. Documented residual: a full swap of the corridor's two real addresses across BOTH routes
  // still closes under this rule (it is a relative check, not an on-chain one — see routes.ts's
  // own doc comment on assertCorridorClosure). Constructed here, not just asserted, so the
  // limitation is evidence.
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

  // 3c. Duplicate-source guard: two routes sharing (sourceChain, sourceEmitter) on the same
  // destination — onEmitter would silently keep only the last one registered.
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

  // 3d. Return routes. A chain id that typo'd into a THIRD known chain leaves a route that nothing
  // mirrors: `routesFor` lets it through (a table built for one direction is legitimate for the
  // checks that drive it), `servedRoutes`, which every process uses, refuses it.
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

  // Drive each direction shape through the real wireRoutes + onEmitter + receiveMessage path.
  const hydDest = fakeApp();
  const hydQueue = fakeQueue();
  const hydClients = await buildClients();
  wireRoutes(hydDest.app, routesFor(WORMHOLE.hydration, bothDirections), hydClients, hydQueue.queue as never);

  const baseDest = fakeApp();
  const baseQueue = fakeQueue();
  const baseClientsStandIn = await buildClients(); // stand-in ChainClients — see file header
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

  // Mutation: a wireRoutes that subscribes every route under one hardcoded chain instead of reading
  // route.sourceChain, the defect this section guards against.
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
  // Uses an EVM source chain (Ethereum) for the added route — a Solana source with an H160
  // emitter cannot exist (Solana emitters are program-derived addresses, not 20-byte EVM
  // addresses); see routes.ts's doc comment on PsmRoute.sourceEmitter for why that is a type
  // change, not a table entry.

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
  const processClients = await buildClients(); // one wallet, built once, for the process lifetime

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

  // Mutation: a wireRoutes that only ever wires the first route in the list, so a second-route
  // addition would silently do nothing.
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

  // With the shipped table (blank), routesFor's whole-table validation throws on "mint"'s blank
  // sourceEmitter before makeApp's own "no routes for this destination" guard is ever reached for
  // ANY destinationChain argument — that guard clause is effectively unreachable through the real
  // ROUTE_TABLE while it ships blank. Both checks below need a validly-filled table to exercise
  // the code past that point, so both temporarily fill the real (shipped-blank) table in place,
  // then restore it immediately after — on either success or failure — so it is never left
  // mutated for any later check (in particular, section 1's shipped-table assertions above have
  // already run by this point, but nothing after this block may assume the table is still blank).
  {
    const originalMint = { ...ROUTE_TABLE[0]! };
    const originalRedeem = { ...ROUTE_TABLE[1]! };
    Object.assign(ROUTE_TABLE[0]!, mintRoute());
    Object.assign(ROUTE_TABLE[1]!, redeemRoute());
    try {
      // 6a. No route configured for a destination that simply isn't in the (now valid) table.
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

      // 6b. makeApp forwards ITS OWN key argument to clientFactory, unchanged — it never resolves
      // a key itself. `spyFactory` throws immediately after capturing, so this never reaches
      // queue.init()/app.listen() (no network beyond the capture).
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

      // 6d. Swapped entry wiring: a client factory for one chain paired with the other chain's
      // destination, in either direction, builds clients cleanly (each factory asserts only that its
      // own RPC is its own chain) and would serve routes through the wrong wallet.
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

      // 6h. makeApp itself serves routes through the stricter lookup: with redeem's sourceChain
      // typo'd into a third known chain, no route mirrors mint, and the process refuses to start.
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

    // A hand-built bundle whose wallet is on another chain than its public client.
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
      "assertDestination refuses a hand-built bundle whose wallet and public client are on different chains",
      () => console.log(`  message: ${mixedMsg || "(did not throw)"}`),
    );

    // A destination with no EVM chain id this app knows.
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

  // Composition check (not a behavioral proof — see note): hydration.ts and base.ts each boot()
  // immediately on import (a real network/Redis/spy connection), so they cannot be imported here
  // to observe their behavior directly. This reads their source to confirm each calls the key
  // getter it is supposed to; the functional proof that the getters themselves are isolated lives
  // in verify-base-clients.ts's "key isolation" section, and the proof that makeApp plumbs
  // whatever key it is given lives in the check just above.
  {
    const fs = await import("node:fs");
    // Comments (this very file's included) freely say "NOT privateKey()" in prose — strip them
    // first so the check reads only real code, not a doc comment quoting the name it warns against.
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
      squash(baseSrc).includes('import { baseClients } from "../../engine/base";'),
      "composition: base.ts imports baseClients from ../../engine/base under its own name",
    );
    record(
      squash(hydrationSrc).includes('import { hydrationClients } from "../../engine/hydration";'),
      "composition: hydration.ts imports hydrationClients from ../../engine/hydration under its own name",
    );

    // The wiring itself. makeApp is driven above with arguments chosen here, so an entry point that
    // hands it the wrong namespace, destination, client factory or floors passes every functional
    // check; only the entry's own text can show it.
    record(
      squash(baseSrc).includes(
        "makeApp(APP_NAME_BASE, WORMHOLE.base, baseClients, RPC_BASE, key, FROM_SEQUENCE_FROM_HYDRATION)",
      ),
      "composition: base.ts hands makeApp Base's own namespace, destination, client factory, RPC and floors",
    );
    record(
      squash(hydrationSrc).includes(
        "makeApp(APP_NAME_HYDRATION, WORMHOLE.hydration, hydrationClients, RPC_HYDRATION, key, FROM_SEQUENCE_FROM_BASE)",
      ),
      "composition: hydration.ts hands makeApp Hydration's own namespace, destination, client factory, RPC and floors",
    );

    // The route table is checked first, through the lookup that also requires return routes.
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
  // config.ts's `opt()` calls run once at module load, so this needs a fresh process per env
  // combination rather than re-importing the module in this one.

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

    // Mutation sanity: both processes reading the literal "APP_NAME" through the real `opt()` helper
    // really do collapse onto one namespace, which shows this check can tell the per-process shape
    // from a shared one.
    const legacyProbe = `
      import { opt } from "../src/config";
      console.log(JSON.stringify({
        hydration: opt("APP_NAME", "psm-hydration-relayer"),
        base: opt("APP_NAME", "psm-base-relayer"),
      }));
    `;
    const legacyCollapsed = JSON.parse(await runInSubprocess(legacyProbe, { APP_NAME: "collapsed" }));
    record(
      legacyCollapsed.hydration === "collapsed" && legacyCollapsed.base === "collapsed",
      "mutation sanity: the pre-fix shape (both reading APP_NAME) really does collapse both processes onto one value",
      () => console.log("  got:", legacyCollapsed),
    );
  }

  // ─── 8. Receipts: a delivery that reverts on chain is handed back ───────────
  // The queue resolves a task as soon as its transaction is broadcast, so it cannot tell a
  // delivery that landed from one that mined and reverted — a pause or a spent limit landing first
  // in the same block, or a gas limit estimated on the other path. The handler reads the receipt
  // itself. This drives the real handler through the real queue over the mocked transport.
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

    // Control: a delivery that lands resolves the handler, after its receipt was read.
    mock.state.receipt = "success";
    const landed = await run(10n);
    record(
      landed.error === undefined && landed.nexted === 1 && landed.sent === 1 && landed.reads === 1,
      "receipt: a delivery that lands resolves the handler, after one broadcast and one receipt read",
      () => console.log("  ", landed),
    );

    // The case this section exists for: broadcast, mined, reverted. The queue has already resolved
    // the task, so only the handler's own receipt read can reject it for the engine to retry.
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

    // Already done: nothing is sent, so there is no receipt to read, and the job resolves.
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

    // The retry the engine would make for the reverted job simulates again and lands.
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
