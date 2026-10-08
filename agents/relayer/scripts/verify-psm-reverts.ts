/**
 * Verification for how the PSM app reads a revert, no network.
 *
 * The queue acts on a revert's NAME (`engine/queue.ts`): "done" resolves the job, anything else is
 * handed back to the engine to retry. A name only exists if the ABI the call was simulated with
 * declares the error, and a custom error is matched by its 4-byte selector, so a signature that is
 * wrong by one type decodes to nothing and the failure is retried as if it were unknown. This
 * script checks that chain end to end against the PSM contracts as the compiler sees them, not
 * against a copy of them written here:
 *
 *   1. It compiles the contracts with forge and reads the compiler's own output, the AST and the
 *      ABI of each receiver. The errors a delivery can raise are found by walking the call graph
 *      from `receiveMessage`: every function, modifier and library call the AST resolves is
 *      followed (a call to a virtual function lands on the receiver's own override), and every
 *      custom error those bodies name is collected. Every error in `receiverAbi` is declared by
 *      the compiled ABI with the same name and parameter types, and the set is exactly what the
 *      walk finds, so a new error anywhere on that path fails here, in a helper or a library.
 *   2. Given the real revert data for each error, built from the compiled declarations rather than
 *      from `receiverAbi`, the real `receiveMessage()` and the real `createQueue()` resolve
 *      `MessageAlreadyProcessed` as done and hand every other named error back for retry, on both
 *      chains' clients, without ever spending a nonce.
 *   3. The failure this prevents is constructed: the same revert, simulated with an ABI that has no
 *      error entries, is not recognised.
 *   4. What `revert.ts` already classified is unchanged.
 *   5. The retry budget in `apps/psm/config.ts` is what its comment says it is.
 *
 * Needs the PSM contracts, which this repo only has once they are merged, and Foundry with the
 * contracts' dependencies installed (`pnpm --filter @whm/contracts install`). Until the contracts
 * are merged pass the path to a checkout's `contracts` directory, or set `PSM_CONTRACTS_DIR`:
 *
 *   pnpm --filter @whm/relayer verify:psm-reverts /path/to/checkout/contracts
 *
 * It builds into a temporary directory and leaves the checkout as it found it. With the contracts
 * or forge absent it exits 1 rather than skip: a check that cannot see the contracts has checked
 * nothing.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  concat,
  encodeAbiParameters,
  getAddress,
  parseAbi,
  toFunctionSelector,
  type Abi,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { receiverAbi } from "../src/apps/psm/abi";
import { RETRIES, RETRY_BASE_MS, RETRY_MAX_MS } from "../src/apps/psm/config";
import { baseClients } from "../src/engine/base";
import { hydrationClients, receiveMessage, type ChainClients } from "../src/engine/hydration";
import { createQueue } from "../src/engine/queue";
import { isDead, isDone } from "../src/engine/revert";
import logger from "../src/logger";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Anvil/Hardhat's well-known default account #0 key: public and funds-free, used only to sign
// throwaway transactions that are never broadcast (see verify-hydration-fees.ts, same use).
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const MOCK_RPC_URL = "http://mock-rpc.invalid";
const TO = getAddress("0x00000000000000000000000000000000000000bb");
const VAA_BYTES = Buffer.from("cafebabe", "hex");
const HYDRATION_CHAIN_ID = 222222;
const BASE_CHAIN_ID = 8453;

let failed = false;
function record(ok: boolean, label: string, detail?: () => void): void {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${label}`);
  if (!ok) {
    detail?.();
    failed = true;
  }
}

// The queue's own balance check logs through the shared logger on every task.
logger.silent = true;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

// ─── The contracts, as the compiler sees them ────────────────────────────────────

const contractsDir = resolve(
  process.argv[2] ?? process.env.PSM_CONTRACTS_DIR ?? join(__dirname, "../../../contracts"),
);

if (!existsSync(join(contractsDir, "foundry.toml")) || !existsSync(join(contractsDir, "src", "psm"))) {
  console.error(
    `verify-psm-reverts: no PSM contracts project at ${contractsDir} (it needs foundry.toml and src/psm).\n` +
      "Pass the path to a checkout's contracts directory, or set PSM_CONTRACTS_DIR.",
  );
  process.exit(1);
}

const scratch = mkdtempSync(join(tmpdir(), "verify-psm-reverts-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));

// Only src/psm and what it imports is compiled: the test and script directories are pointed at
// places that do not exist, so an unrelated test that stops compiling cannot fail this script.
const build = spawnSync(
  process.env.FORGE ?? "forge",
  [
    "build",
    "--root", contractsDir,
    "-C", "src/psm",
    "--out", join(scratch, "out"),
    "--cache-path", join(scratch, "cache"),
    "--build-info",
    "--build-info-path", join(scratch, "build-info"),
    "--ast",
  ],
  {
    encoding: "utf8",
    maxBuffer: 1 << 28,
    env: {
      ...process.env,
      FOUNDRY_PROFILE: process.env.FOUNDRY_PROFILE ?? "psm",
      FOUNDRY_TEST: join(scratch, "no-tests"),
      FOUNDRY_SCRIPT: join(scratch, "no-scripts"),
    },
  },
);
if (build.error || build.status !== 0) {
  const why = build.error ? build.error.message : String(build.stderr).trim().split("\n").slice(-25).join("\n");
  console.error(
    `verify-psm-reverts: forge could not build the PSM contracts in ${contractsDir}.\n${why}\n` +
      "It needs Foundry on PATH (or FORGE) and the contracts' dependencies installed " +
      "(pnpm --filter @whm/contracts install).",
  );
  process.exit(1);
}

interface AstNode {
  nodeType: string;
  id: number;
  name?: string;
  [key: string]: unknown;
}
interface AbiErrorLike {
  type: string;
  name: string;
  inputs: { type: string }[];
}
interface BuildOutput {
  sources: Record<string, { ast: AstNode }>;
  contracts: Record<string, Record<string, { abi: AbiErrorLike[] }>>;
}

const infoFiles = readdirSync(join(scratch, "build-info")).filter((f) => f.endsWith(".json"));
if (infoFiles.length !== 1) {
  console.error(`verify-psm-reverts: expected one build-info file from forge, found ${infoFiles.length}.`);
  process.exit(1);
}
const output = (JSON.parse(readFileSync(join(scratch, "build-info", infoFiles[0]!), "utf8")) as { output: BuildOutput })
  .output;

/** Every AST node by id, and the contract each function or modifier is declared in, for labels. */
const byId = new Map<number, AstNode>();
const ownerOf = new Map<number, string>();
function index(node: unknown, owner?: string): void {
  if (Array.isArray(node)) {
    for (const n of node) index(n, owner);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const n = node as AstNode;
  if (typeof n.nodeType === "string" && typeof n.id === "number") {
    byId.set(n.id, n);
    if (n.nodeType === "ContractDefinition") owner = n.name;
    else if (owner !== undefined) ownerOf.set(n.id, owner);
  }
  for (const v of Object.values(n)) index(v, owner);
}
for (const { ast } of Object.values(output.sources)) index(ast);

function contractNode(path: string, name: string): AstNode {
  const found = (output.sources[path]?.ast.nodes as AstNode[] | undefined)?.find(
    (n) => n.nodeType === "ContractDefinition" && n.name === name,
  );
  if (!found) throw new Error(`${name} not found in ${path}`);
  return found;
}

/** Every function id that `fn` overrides, directly or through a chain of overrides. */
const overrideCache = new Map<number, Set<number>>();
function overridesOf(fn: AstNode): Set<number> {
  const cached = overrideCache.get(fn.id);
  if (cached) return cached;
  const out = new Set<number>();
  overrideCache.set(fn.id, out);
  for (const baseId of (fn.baseFunctions as number[] | undefined) ?? []) {
    out.add(baseId);
    const base = byId.get(baseId);
    if (base) for (const id of overridesOf(base)) out.add(id);
  }
  return out;
}

/** What a call to `fn` runs inside `receiver`: its most derived override, or `fn` itself. */
function implementationIn(receiver: AstNode, fn: AstNode): AstNode {
  if (fn.nodeType !== "FunctionDefinition") return fn;
  for (const id of receiver.linearizedBaseContracts as number[]) {
    for (const member of byId.get(id)!.nodes as AstNode[]) {
      if (member.nodeType === "FunctionDefinition" && (member.id === fn.id || overridesOf(member).has(fn.id))) {
        return member;
      }
    }
  }
  return fn;
}

interface Reach {
  /** Custom errors named by any body on the path. */
  errors: Set<string>;
  /** `Contract.function` for everything the walk visited, to show it looked at the right code. */
  functions: Set<string>;
}

/**
 * The call graph from `receiveMessage` on `receiver`. Any AST node that refers to a function or
 * modifier with a body is followed, wherever it appears (a call, a modifier invocation, a library
 * function bound with `using`), and any node that refers to an error definition is an error the
 * path can raise. Calls through an interface have no body here and are other contracts' reverts.
 */
function reach(receiver: AstNode): Reach {
  const entry = (receiver.linearizedBaseContracts as number[])
    .flatMap((id) => byId.get(id)!.nodes as AstNode[])
    .find((m) => m.nodeType === "FunctionDefinition" && m.name === "receiveMessage" && m.body);
  if (!entry) throw new Error(`${receiver.name} has no receiveMessage`);

  const errors = new Set<string>();
  const functions = new Set<string>();
  const seen = new Set<number>();
  const todo: AstNode[] = [entry];

  function visit(node: unknown): void {
    if (Array.isArray(node)) {
      for (const n of node) visit(n);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    if (typeof n.referencedDeclaration === "number") {
      const target = byId.get(n.referencedDeclaration);
      if (target?.nodeType === "ErrorDefinition") errors.add(target.name!);
      else if (
        (target?.nodeType === "FunctionDefinition" || target?.nodeType === "ModifierDefinition") &&
        target.body
      ) {
        todo.push(implementationIn(receiver, target));
      }
    }
    for (const v of Object.values(n)) visit(v);
  }

  while (todo.length > 0) {
    const fn = todo.pop()!;
    if (seen.has(fn.id)) continue;
    seen.add(fn.id);
    functions.add(`${ownerOf.get(fn.id) ?? "?"}.${fn.name}`);
    visit(fn);
  }
  return { errors, functions };
}

/** The compiled ABI's errors, name to canonical signature. */
function compiledErrors(path: string, name: string): Map<string, string> {
  const abi = output.contracts[path]?.[name]?.abi;
  if (!abi) throw new Error(`no compiled ABI for ${name} in ${path}`);
  return new Map(
    abi
      .filter((item) => item.type === "error")
      .map((e) => [e.name, `${e.name}(${e.inputs.map((i) => i.type).join(",")})`]),
  );
}

function analyse(name: string, path: string) {
  return { name, ...reach(contractNode(path, name)), compiled: compiledErrors(path, name) };
}
const vault = analyse("HollarBaseVault", "src/psm/HollarBaseVault.sol");
const facilitator = analyse("HollarBaseFacilitator", "src/psm/HollarBaseFacilitator.sol");
const receivers = [vault, facilitator];

/**
 * Statically reachable, never raised: `_publish` refunds the excess of `msg.value` over the Wormhole
 * fee, and `receiveMessage` is non-payable, so `msg.value` is zero and there is no excess. Anything
 * else the walk finds that `receiverAbi` lacks fails the check below.
 */
const UNREACHABLE = new Set(["RefundFailed"]);

type AbiErrorItem = Extract<(typeof receiverAbi)[number], { type: "error" }>;
const abiErrors = receiverAbi.filter((item): item is AbiErrorItem => item.type === "error");
const abiNames = new Set<string>(abiErrors.map((e) => e.name));
const abiSignature = (e: AbiErrorItem) => `${e.name}(${e.inputs.map((i) => i.type).join(",")})`;

/** Every signature the two receivers' compiled ABIs give a name. */
const declared = new Map<string, Set<string>>();
for (const r of receivers) {
  for (const [name, signature] of r.compiled) {
    if (!declared.has(name)) declared.set(name, new Set());
    declared.get(name)!.add(signature);
  }
}

const raised = new Set([...vault.errors, ...facilitator.errors]);
for (const name of UNREACHABLE) raised.delete(name);

// The walk must be looking at the receive path, or an empty set would pass for a complete one.
record(
  receivers.every(
    (r) =>
      r.functions.has(`${r.name}._processMessage`) &&
      r.functions.has("MessageReceiver.receiveMessage") &&
      r.functions.has("PsmPayload.decode"),
  ),
  "the walk from receiveMessage reaches each receiver's _processMessage, the shared entry point and the payload decoder",
  () => receivers.forEach((r) => console.log(`  ${r.name}: ${[...r.functions].sort().join(", ")}`)),
);

record(
  receivers.every((r) => [...r.errors].every((n) => r.compiled.has(n))),
  "every error the walk finds is in the compiled ABI of the receiver that raises it",
);

record(
  [...abiNames].every((n) => raised.has(n)) && [...raised].every((n) => abiNames.has(n)),
  "receiverAbi declares exactly the custom errors a delivery can raise on the vault and the facilitator",
  () =>
    console.log(
      "  raised, not declared:", [...raised].filter((n) => !abiNames.has(n)),
      "\n  declared, never raised:", [...abiNames].filter((n) => !raised.has(n)),
    ),
);

record(
  abiErrors.every((e) => {
    const sigs = declared.get(e.name);
    return sigs !== undefined && sigs.size === 1 && sigs.has(abiSignature(e));
  }),
  "every receiverAbi error is declared by the compiled contracts with the same name and parameter types",
  () =>
    abiErrors.forEach((e) => {
      const sigs = declared.get(e.name);
      if (!(sigs && sigs.size === 1 && sigs.has(abiSignature(e)))) {
        console.log(`  ${abiSignature(e)} vs contracts: ${sigs ? [...sigs].join(" | ") : "(undeclared)"}`);
      }
    }),
);

record(
  abiErrors.every((e) => {
    const sig = [...(declared.get(e.name) ?? [])][0];
    return sig !== undefined && toFunctionSelector(sig) === toFunctionSelector(abiSignature(e));
  }),
  "every receiverAbi error has the selector the compiled declaration gives it",
);

// The one reachability fact stated outright, not left to the walk: a returned redemption is the
// vault's alone.
record(
  vault.errors.has("ClaimsPaused") && !facilitator.errors.has("ClaimsPaused"),
  "ClaimsPaused is raised by the vault's delivery and not the facilitator's",
);

// ─── Transport mock ──────────────────────────────────────────────────────────────

type JsonRpcRequest = { jsonrpc: "2.0"; id: number; method: string; params?: unknown[] };
type Outcome = { kind: "ok" } | { kind: "revert"; data: Hex };

/**
 * Answers what a submission or a queue balance check asks for, for one chain id. `outcome` is read
 * on every `eth_call`, so a scenario changes it between submissions. Every raw transaction that
 * reaches `eth_sendRawTransaction` is kept: a revert must never get that far.
 */
function installMock(chainId: number, outcome: () => Outcome) {
  const original = globalThis.fetch;
  const sent: Hex[] = [];

  function answer(req: JsonRpcRequest) {
    const { id, method, params } = req;
    switch (method) {
      case "eth_chainId":
        return { jsonrpc: "2.0", id, result: `0x${chainId.toString(16)}` };
      case "eth_call": {
        const o = outcome();
        return o.kind === "ok"
          ? { jsonrpc: "2.0", id, result: "0x" }
          : { jsonrpc: "2.0", id, error: { code: 3, message: "execution reverted", data: o.data } };
      }
      case "eth_estimateGas":
        return { jsonrpc: "2.0", id, result: "0x30d40" };
      case "eth_getBlockByNumber":
        return { jsonrpc: "2.0", id, result: { number: "0x1", baseFeePerGas: "0x3b9aca00" } };
      case "eth_gasPrice":
        return { jsonrpc: "2.0", id, result: "0x12a05f200" };
      case "eth_maxPriorityFeePerGas":
        return { jsonrpc: "2.0", id, result: "0x3b9aca00" };
      case "eth_getBalance":
        return { jsonrpc: "2.0", id, result: `0x${(10n ** 18n).toString(16)}` };
      case "eth_getTransactionCount":
        return { jsonrpc: "2.0", id, result: "0x0" };
      case "eth_sendRawTransaction":
        sent.push((params as [Hex])[0]);
        return { jsonrpc: "2.0", id, result: `0x${"22".repeat(32)}` };
      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `mock: unhandled ${method}` } };
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

  return { restore: () => void (globalThis.fetch = original), sent };
}

/** Revert data for `name`, built from the contracts' declaration and nothing in this repo. */
function revertData(signature: string): Hex {
  const selector = toFunctionSelector(signature);
  const types = signature.slice(signature.indexOf("(") + 1, -1).split(",").filter(Boolean);
  if (types.length === 0) return selector;
  const sample: Record<string, unknown> = {
    uint8: 3,
    uint16: 30,
    uint64: 42n,
    uint256: 1n,
    bytes32: `0x${"00".repeat(31)}01`,
    address: TO,
  };
  const values = types.map((t) => {
    if (!(t in sample)) throw new Error(`no sample value for ${t}`);
    return sample[t];
  });
  return concat([selector, encodeAbiParameters(types.map((type) => ({ type })), values)]);
}

interface Log {
  info: string[];
  warn: string[];
}

function capture(): { log: Log; logger: typeof logger } {
  const log: Log = { info: [], warn: [] };
  const sink = {
    info: (m: string) => void log.info.push(String(m)),
    warn: (m: string) => void log.warn.push(String(m)),
    error: (m: string) => void log.warn.push(String(m)),
  };
  return { log, logger: sink as unknown as typeof logger };
}

interface Run {
  settled: "resolved" | "rejected";
  log: Log;
  sent: number;
}

/**
 * One delivery through the real stack: `receiveMessage()` simulates the call with `abi`, and the
 * real queue classifies whatever it throws.
 */
async function deliver(
  clients: ChainClients,
  queue: ReturnType<typeof createQueue>,
  abi: Abi,
  sentSoFar: () => number,
): Promise<Run> {
  const before = sentSoFar();
  const { log, logger: taskLogger } = capture();
  const settled = await queue
    .add({
      label: "psm",
      logger: taskLogger,
      submit: (n) => receiveMessage(clients, abi, TO, VAA_BYTES, n),
    })
    .then(() => "resolved" as const)
    .catch(() => "rejected" as const);
  return { settled, log, sent: sentSoFar() - before };
}

async function main() {
  const account = privateKeyToAccount(KEY);

  // `PayoutFailed` is the vault's, raised when a payout's transfer fails (`_settle`, under `claim` and
  // `drain`) — not by a delivery. receiverAbi leaves it out on that ground; stated as a check so the
  // ground is the compiler's, not this comment's.
  const payoutFailed = vault.compiled.get("PayoutFailed");
  record(
    payoutFailed !== undefined && !raised.has("PayoutFailed") && !abiNames.has("PayoutFailed"),
    "PayoutFailed is in the vault's compiled ABI, is not raised by a delivery, and is not in receiverAbi",
  );
  if (!payoutFailed) throw new Error("PayoutFailed is not in the vault's compiled ABI");

  // ─── 2 and 3. Real revert data through the real stack ──────────────────────────

  const DONE = new Set(["MessageAlreadyProcessed"]);
  const chains = [
    { label: "hydration", chainId: HYDRATION_CHAIN_ID, build: hydrationClients },
    { label: "base", chainId: BASE_CHAIN_ID, build: baseClients },
  ] as const;

  for (const { label, chainId, build } of chains) {
    let outcome: Outcome = { kind: "ok" };
    const mock = installMock(chainId, () => outcome);
    try {
      const clients = await build(MOCK_RPC_URL, KEY);
      const queue = createQueue({ publicClient: clients.publicClient, account, warnMultiplier: 50n });
      await queue.init();
      const sentSoFar = () => mock.sent.length;

      // Control: with nothing reverting, the same path does send a transaction, so "sent: 0"
      // below means something.
      outcome = { kind: "ok" };
      const ok = await deliver(clients, queue, receiverAbi, sentSoFar);
      record(
        ok.settled === "resolved" && ok.sent === 1 && ok.log.info.some((l) => l.includes("submitted in")),
        `${label}: control: a delivery that does not revert is sent`,
        () => console.log("  ", ok),
      );

      // Driven by what the contracts raise, not by what receiverAbi lists, so an entry the ABI is
      // missing shows up here as an error that goes unnamed rather than as a loop that skips it.
      for (const name of [...raised].sort()) {
        const signature = [...(declared.get(name) ?? [])][0];
        if (signature === undefined) {
          record(false, `${label}: ${name} is raised by a delivery but is in no compiled ABI read`);
          continue;
        }
        outcome = { kind: "revert", data: revertData(signature) };
        const run = await deliver(clients, queue, receiverAbi, sentSoFar);
        const warn = run.log.warn.join("\n");
        const info = run.log.info.join("\n");

        if (DONE.has(name)) {
          record(
            run.settled === "resolved" && run.sent === 0 && info.includes(`already completed (${name})`),
            `${label}: ${name} resolves as already completed, and spends no nonce`,
            () => console.log("  ", run),
          );
        } else {
          record(
            run.settled === "rejected" && run.sent === 0 && warn.includes(`failed (${name})`),
            `${label}: ${name} is named and handed back for retry, and spends no nonce`,
            () => console.log("  ", run),
          );
        }
      }

      // A vault error the delivery never raises (a payout one): declared by the contracts, absent
      // from receiverAbi, so it decodes to no name and is retried like any unknown revert.
      outcome = { kind: "revert", data: revertData(payoutFailed) };
      const unnamed = await deliver(clients, queue, receiverAbi, sentSoFar);
      record(
        unnamed.settled === "rejected" &&
          unnamed.sent === 0 &&
          unnamed.log.warn.some((l) => /failed: /.test(l)),
        `${label}: an error receiverAbi does not declare (PayoutFailed) is unnamed, and handed back for retry`,
        () => console.log("  ", unnamed),
      );

      // Construct the failure the declarations prevent. Same revert data, simulated with an ABI
      // that has no error entries — what this app used before: the refused copy is not recognised.
      const bare = parseAbi(["function receiveMessage(bytes vaa) external"]);
      const sig = [...declared.get("MessageAlreadyProcessed")!][0]!;
      outcome = { kind: "revert", data: revertData(sig) };
      const before = await deliver(clients, queue, bare, sentSoFar);
      record(
        before.settled === "rejected" && !before.log.info.some((l) => l.includes("already completed")),
        `${label}: without error entries in the ABI, a refused second copy is not recognised and is retried`,
        () => console.log("  ", before),
      );
    } finally {
      mock.restore();
    }
  }

  // ─── 4. What was classified before still is ────────────────────────────────────

  record(
    isDone("AlreadyRedeemed") &&
      isDone("TransferAlreadyCompleted") &&
      isDone("StalePriceUpdate") &&
      isDone("VAA already processed") &&
      isDead("Price too stale") &&
      isDead("Price too low to scale"),
    "revert.ts: the names it already classified (intent, ntt, oracle) are still classified",
  );
  record(
    !isDone("ClaimsPaused") && !isDead("ClaimsPaused") && !isDone(undefined) && !isDead(undefined),
    "revert.ts: a transient PSM revert and an unnamed one are neither done nor dead",
  );
  record(
    isDone("MessageAlreadyProcessed") && !isDead("MessageAlreadyProcessed"),
    "revert.ts: MessageAlreadyProcessed is done, not dead",
  );

  // ─── 5. The retry budget ───────────────────────────────────────────────────────

  /**
   * Total wait the engine's backoff adds across a job's retries: `min(2^attempt * base, max)` after
   * each failed attempt, counting from 1 (relayer-engine's `redis-storage.ts` `backOffFunction`).
   */
  function budgetDays(retries: number, baseMs: number, maxMs: number): number {
    let ms = 0;
    for (let attempt = 1; attempt < retries; attempt++) ms += Math.min(2 ** attempt * baseMs, maxMs);
    return ms / 86_400_000;
  }
  const days = budgetDays(RETRIES, RETRY_BASE_MS, RETRY_MAX_MS);
  record(
    days >= 4.5 && days <= 5.5,
    `apps/psm/config.ts: ${RETRIES} attempts at base ${RETRY_BASE_MS / 1000}s, capped at ${RETRY_MAX_MS / 60000} min, span about five days (${days.toFixed(2)})`,
  );

  const appSource = stripComments(readFileSync(join(__dirname, "../src/apps/psm/app.ts"), "utf8"));
  record(
    /retries:\s*RETRIES/.test(appSource) &&
      /backoff:\s*\{\s*baseMs:\s*RETRY_BASE_MS,\s*maxMs:\s*RETRY_MAX_MS\s*\}/.test(appSource),
    "composition: makeApp hands the engine the retries AND the backoff (a job without a backoff is retried at once)",
  );

  if (failed) {
    console.error("\nverify-psm-reverts: FAILED");
    process.exit(1);
  }
  console.log("\nverify-psm-reverts: all checks passed");
}

main();
