/**
 * `ntt-base` delivery over mocked clients: the verdict after a receipt comes from its logs and from
 * reads pinned to its block; a send without a receipt is settled before anything is sent again; a
 * failed Discord post is logged; the grace period is validated.
 *
 * Run: `pnpm test` in agents/relayer (node:test through the root's tsx; no RPC, no Redis).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { Writable } from "node:stream";

import * as winston from "winston";
import {
  encodeAbiParameters,
  encodeEventTopics,
  pad,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Address,
  type Hash,
  type Hex,
  type TransactionReceipt,
} from "viem";

import type { ChainClients } from "../../clients/hydration";
import type { Queue } from "../../engine/queue";
import type { ParsedVaa } from "../../types";

import { DEFAULT_GRACE_SECONDS, graceSeconds, MAX_GRACE_SECONDS } from "./config";
import { deliverOutbound, discordAlert, managerDigest, outboundAbi, type SentLedger } from "./outbound";
import type { OutboundNttRoute } from "./routes";

const MANAGER = `0x${"aa".repeat(20)}` as Address;
const TRANSCEIVER = `0x${"bb".repeat(20)}` as Address;
const BASE = 30;
const BLOCK = 1_000n;
const OUR_TX = `0x${"01".repeat(32)}` as Hash;

const route = {
  token: "EURC",
  sourceEmitter: `0x${"cc".repeat(32)}`,
  manager: MANAGER,
  transceiver: TRANSCEIVER,
  destinationChain: BASE,
} as unknown as OutboundNttRoute;

/** A transfer payload with only the fields `deliverOutbound` reads: prefix, manager, toChain. */
function transferVaa(): ParsedVaa {
  const payload = Buffer.alloc(260);
  payload.write("9945ff10", 0, "hex");
  payload.write(pad(MANAGER, { size: 32 }).slice(2), 36, "hex");
  payload.writeUInt16BE(150, 68); // manager message length
  payload.write("9945ff10", 136, "hex");
  payload.writeUInt16BE(BASE, 136 + 4 + 1 + 8 + 32 + 32);
  const body = Buffer.alloc(51 + payload.length);
  payload.copy(body, 51);
  const bytes = Buffer.concat([Buffer.from([1, 0, 0, 0, 0, 0]), body]); // version, set, 0 signatures
  return { bytes, payload, sequence: 7n, emitterChain: 73, emitterAddress: Buffer.alloc(32), timestamp: 0 };
}

const vaa = transferVaa();
const digest = managerDigest(vaa.emitterChain, vaa.payload);

function managerLog(eventName: "InboundTransferQueued" | "TransferRedeemed", d: Hash = digest) {
  if (eventName === "TransferRedeemed") {
    return { address: MANAGER, topics: encodeEventTopics({ abi: outboundAbi, eventName, args: { digest: d } }), data: "0x" as Hex };
  }
  return {
    address: MANAGER,
    topics: encodeEventTopics({ abi: outboundAbi, eventName }),
    data: encodeAbiParameters([{ type: "bytes32" }], [d]),
  };
}

function receipt(status: "success" | "reverted", logs: ReturnType<typeof managerLog>[] = []): TransactionReceipt {
  return { transactionHash: OUR_TX, status, blockNumber: BLOCK, logs } as unknown as TransactionReceipt;
}

/** Captures what the logger writes, one `level: message` per line. */
function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString().trimEnd());
      cb();
    },
  });
  const log = winston.createLogger({
    format: winston.format.printf((i) => `${i.level}: ${i.message}`),
    transports: [new winston.transports.Stream({ stream })],
  });
  return { log, lines };
}

interface Reads {
  /** Manager/transceiver state per block tag ("latest" or the block number as a string). */
  consumed?: Record<string, boolean>;
  executed?: Record<string, boolean>;
  queued?: Record<string, boolean>;
  /** Blocks the node cannot serve. */
  unserved?: string[];
}

function harness(opts: {
  reads?: Reads;
  wait?: () => Promise<TransactionReceipt>;
  receipts?: Record<Hash, TransactionReceipt>;
  pending?: Hash[];
  sent?: SentLedger;
}) {
  const r = opts.reads ?? {};
  const calls: { fn: string; at: string }[] = [];
  let sends = 0;
  const read = (fn: string, at: string) => {
    calls.push({ fn, at });
    if (r.unserved?.includes(at)) throw new Error(`header not found (block ${at})`);
    switch (fn) {
      case "isVAAConsumed":
        return r.consumed?.[at] ?? false;
      case "isMessageExecuted":
        return r.executed?.[at] ?? false;
      case "getInboundQueuedTransfer":
        return r.queued?.[at]
          ? { amount: (908196247n << 8n) | 6n, txTimestamp: 1_700_000_000n, recipient: `0x${"dd".repeat(20)}` }
          : { amount: 0n, txTimestamp: 0n, recipient: `0x${"00".repeat(20)}` };
      case "rateLimitDuration":
        return 86_400n;
    }
    throw new Error(`unexpected read ${fn}`);
  };
  const publicClient = {
    readContract: async (a: { functionName: string; blockNumber?: bigint }) =>
      read(a.functionName, a.blockNumber === undefined ? "latest" : a.blockNumber.toString()),
    simulateContract: async () => ({}),
    getBlock: async () => ({}),
    getGasPrice: async () => 1n,
    waitForTransactionReceipt: opts.wait ?? (async () => receipt("success", [managerLog("TransferRedeemed")])),
    getTransactionReceipt: async ({ hash }: { hash: Hash }) => {
      const found = opts.receipts?.[hash];
      if (!found) throw new TransactionReceiptNotFoundError({ hash });
      return found;
    },
    getTransaction: async ({ hash }: { hash: Hash }) => {
      if (opts.pending?.includes(hash)) return { hash, blockNumber: null };
      throw new TransactionNotFoundError({ hash });
    },
  };
  const clients = {
    publicClient,
    wallet: { chain: { id: 8453, name: "base" }, writeContract: async () => ((sends++), OUR_TX) },
    account: { address: `0x${"11".repeat(20)}` },
  } as unknown as ChainClients;
  const queue = { add: async (task: { submit: (n: number) => Promise<Hash> }) => void (await task.submit(7)) } as unknown as Queue;
  const alerts: string[] = [];
  const sent = opts.sent ?? new Map();
  const { log, lines } = capture();
  const run = () =>
    deliverOutbound(route, vaa, clients, queue, log, {
      graceSeconds: 0,
      now: () => 10_000,
      sent,
      alert: async (m) => void alerts.push(m),
    });
  return { run, calls, alerts, sent, lines, sends: () => sends };
}

test("queued in the receipt's logs: queued and alerted, though latest still reads an empty queue", async () => {
  const h = harness({
    wait: async () => receipt("success", [managerLog("InboundTransferQueued")]),
    // A node behind the receipt: latest has no queue entry; the receipt's block has it.
    reads: { queued: { [BLOCK.toString()]: true } },
  });
  assert.equal(await h.run(), "queued");
  assert.equal(h.alerts.length, 1);
  assert.match(h.alerts[0], /completeInboundQueuedTransfer/);
  assert.match(h.alerts[0], /908\.196247 EURC/);
  const after = h.calls.filter((c) => c.fn === "getInboundQueuedTransfer" || c.fn === "rateLimitDuration");
  assert.ok(after.length > 0 && after.every((c) => c.at === BLOCK.toString()), "detail reads pinned to the receipt block");
});

test("queued in the logs and the block unreadable: still queued, alerted without the details", async () => {
  const h = harness({
    wait: async () => receipt("success", [managerLog("InboundTransferQueued")]),
    reads: { unserved: [BLOCK.toString()] },
  });
  assert.equal(await h.run(), "queued");
  assert.equal(h.alerts.length, 1);
  assert.match(h.alerts[0], /details unread: header not found/);
});

test("redeemed in the logs: delivered", async () => {
  const h = harness({ wait: async () => receipt("success", [managerLog("TransferRedeemed")]) });
  assert.equal(await h.run(), "delivered");
  assert.equal(h.alerts.length, 0);
  assert.equal(h.sent.size, 0, "the ledger forgets a settled send");
});

test("a successful receipt with neither manager event (or another digest's) is not delivered", async () => {
  const other = `0x${"ee".repeat(32)}` as Hash;
  const h = harness({ wait: async () => receipt("success", [managerLog("TransferRedeemed", other)]) });
  await assert.rejects(h.run(), /not proven delivered/);
});

test("a reverted receipt is re-read at its block, not at latest", async () => {
  const at = BLOCK.toString();
  const lost = harness({
    wait: async () => receipt("reverted"),
    // Latest (a lagging node) still reads open; the receipt's block reads consumed.
    reads: { consumed: { [at]: true }, executed: { [at]: true } },
  });
  assert.equal(await lost.run(), "completed-elsewhere");

  const unserved = harness({ wait: async () => receipt("reverted"), reads: { unserved: [at] } });
  await assert.rejects(unserved.run(), /header not found/);
});

test("a receipt timeout leaves the send in the ledger; the retry sends nothing while it is pending", async () => {
  const sent: SentLedger = new Map();
  const first = harness({ sent, wait: async () => Promise.reject(new Error("Timed out while waiting")) });
  await assert.rejects(first.run(), /Timed out/);
  assert.equal(first.sends(), 1);
  assert.equal(sent.get(digest), OUR_TX);

  const pending = harness({ sent, pending: [OUR_TX] });
  await assert.rejects(pending.run(), /no receipt yet; not sending again/);
  assert.equal(pending.sends(), 0, "nothing sent while the earlier send is pending");
  assert.equal(pending.calls.length, 0, "no state read either");

  const mined = harness({ sent, receipts: { [OUR_TX]: receipt("success", [managerLog("TransferRedeemed")]) } });
  assert.equal(await mined.run(), "delivered");
  assert.equal(mined.sends(), 0, "the earlier send's receipt is the outcome");
  assert.equal(sent.size, 0);
});

test("a dropped earlier send is forgotten and the retry reads and sends again", async () => {
  const sent: SentLedger = new Map([[digest, OUR_TX]]);
  const h = harness({ sent });
  assert.equal(await h.run(), "delivered");
  assert.equal(h.sends(), 1);
});

test("discordAlert logs an HTTP error with its status and body", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("rate limited", { status: 429 })) as typeof fetch;
  try {
    const { log, lines } = capture();
    await discordAlert("https://discord.invalid/webhook", log)("hello");
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^error: Discord notification failed: HTTP 429 rate limited; undelivered: hello$/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("NTT_BASE_GRACE_SECONDS: whole seconds from 0 to one day, else refuse", () => {
  const saved = process.env.NTT_BASE_GRACE_SECONDS;
  try {
    for (const [raw, want] of [["", DEFAULT_GRACE_SECONDS], ["0", 0], ["900", 900], [" 60 ", 60], [String(MAX_GRACE_SECONDS), MAX_GRACE_SECONDS]] as const) {
      process.env.NTT_BASE_GRACE_SECONDS = raw;
      assert.equal(graceSeconds(), want, `"${raw}"`);
    }
    delete process.env.NTT_BASE_GRACE_SECONDS;
    assert.equal(graceSeconds(), DEFAULT_GRACE_SECONDS);
    for (const raw of ["oops", "-1", "1.5", "1e3", "Infinity", "NaN", "0x10", String(MAX_GRACE_SECONDS + 1)]) {
      process.env.NTT_BASE_GRACE_SECONDS = raw;
      assert.throws(() => graceSeconds(), /NTT_BASE_GRACE_SECONDS must be a whole number/, `"${raw}"`);
    }
  } finally {
    if (saved === undefined) delete process.env.NTT_BASE_GRACE_SECONDS;
    else process.env.NTT_BASE_GRACE_SECONDS = saved;
  }
});
