/**
 * The queued-payout keeper over an in-memory landing that applies `fulfillPending`'s rules
 * (contracts/src/basejump/BasejumpLanding.sol, `fulfillPending`: pay the head when the pool covers
 * it, else revert; a success moves `pendingHead` by one) and, when `parkable`, `parkPending`'s
 * (refuse an unfunded head; pay it if its dispatch succeeds, else move it to `parkedTransfers`;
 * either way the head moves by one), with a mock clock. Money rows (S1-S7, S11, S13, P1, P2, P4):
 * one send per head, no send while a send is unobserved, no spin on an unpayable head, park only a
 * funded head whose dispatch fails. Alert rows (S8-S12c, A1, A2, B1-B4, P1, P3): each row of the
 * README's alert table.
 *
 * Run: `pnpm test` in agents/relayer (node:test through the root's tsx; no RPC, no Redis).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { createPublicClient, custom } from "viem";

import logger from "../../logger";
import { ERC1967_IMPL_SLOT, createPayoutKeeper, landingAbi } from "./payouts";

logger.silent = true;

const LANDING = "0x00000000000000000000000000000000000000aa" as const;
const SRC = "0x0000000000000000000000000000000000000015" as const;
const DEST = "0x0000000100000000000000000000000000000015" as const;
const MIN = 60_000;

type Rcpt = { transactionHash: string; status: "success" | "reverted"; blockNumber: bigint };

/** Implementations behind the landing proxy, before and after the FIFO / park upgrade. */
const IMPL_V1 = "0x00000000000000000000000000000000000000b1";
const IMPL_V2 = "0x00000000000000000000000000000000000000b2";
/** Stand-in bytecode: dispatch PUSH4s only (`fulfillPending`, a filler); V2 also `parkedTransfers(uint256)` (0x3abcdfc4). */
const CODE = {
  [IMPL_V1]: "0x6080604052" + "633404563d" + "63c5f9c6c8",
  [IMPL_V2]: "0x6080604052" + "633404563d" + "63c5f9c6c8" + "633abcdfc4",
} as Record<string, string>;

/**
 * The error viem itself builds from a node's JSON-RPC answer to `eth_call` (a real client over a
 * `custom` transport), so the keeper sees exactly what production hands it.
 *
 * Forms measured on a public Hydration RPC 2026-11-09 (review-37-combined): a revert is
 * `-32603 "VM Exception while processing transaction: revert"` with data 0x, and a node fault is
 * `-32603 "failed to retrieve Runtime Api version"`: the same code.
 */
async function viemErr(err: { code: number; message: string; data?: string }, id: bigint): Promise<unknown> {
  const c = createPublicClient({
    transport: custom({
      async request({ method }) {
        if (method === "eth_call") throw Object.assign(new Error(err.message), err);
        throw new Error("unexpected " + method);
      },
    }, { retryCount: 0 }),
  });
  try {
    await c.readContract({ address: LANDING, abi: landingAbi, functionName: "parkedTransfers", args: [id] });
  } catch (e) {
    return e;
  }
  throw new Error("no error");
}
const LIVE_REVERT = { code: -32603, message: "VM Exception while processing transaction: revert", data: "0x" };
const NODE_FAULT = { code: -32603, message: "failed to retrieve Runtime Api version" };

function world() {
  const w = {
    head: 0n,
    tail: 0n,
    amounts: new Map<bigint, bigint>(),
    pool: 0n,
    receipts: new Map<string, Rcpt>(),
    sends: [] as { hash: string; headAtSend: bigint; fn: string }[],
    calls: [] as string[], // every simulate and write, as "simulate:fn" / "write:fn"
    parkable: false, // the landing has parkPending (the FIFO / park upgrade)
    parked: new Map<bigint, bigint>(),
    block: 1n, // the chain's block number; each mined call is its own block
    parkedReads: [] as { id: bigint; blockNumber: bigint | undefined }[],
    codeFails: false, // the implementation's code read fails
    reads: 0,
    staleHead: undefined as bigint | undefined, // next pendingHead read returns this once
    dispatchFails: new Set<bigint>(),
    // what happens on writeContract: "mine" now, "hold" (never mined unless released), or custom
    onSend: (hash: string, fn: string) => w.mine(hash, fn),
    onWait: async (_hash: string) => {},
    replaceWith: undefined as undefined | ((hash: string) => Rcpt | undefined),
    enqueue(amount: bigint) {
      w.amounts.set(w.tail, amount);
      w.tail++;
    },
    exec(fn = "fulfillPending"): "success" | "reverted" {
      if (fn === "parkPending" && !w.parkable) return "reverted";
      if (w.head >= w.tail) return "reverted";
      const amt = w.amounts.get(w.head)!;
      if (w.pool < amt) return "reverted";
      if (w.dispatchFails.has(w.head)) {
        if (fn !== "parkPending") return "reverted";
        w.parked.set(w.head, amt); // parked: reserved, not paid
        w.amounts.delete(w.head);
        w.head++;
        return "success";
      }
      w.pool -= amt;
      w.amounts.delete(w.head);
      w.head++;
      return "success";
    },
    mine(hash: string, fn = "fulfillPending") {
      w.block++;
      w.receipts.set(hash, { transactionHash: hash, status: w.exec(fn), blockNumber: w.block });
    },
  };
  let n = 0;
  const publicClient: any = {
    async readContract({ functionName, args }: any) {
      w.reads++;
      switch (functionName) {
        case "pendingHead": {
          if (w.staleHead !== undefined) {
            const s = w.staleHead;
            w.staleHead = undefined;
            return s;
          }
          return w.head;
        }
        case "pendingTail":
          return w.tail;
        case "pendingTransfers":
          return [SRC, w.amounts.get(args[0]) ?? 0n, "0x" + "11".repeat(32)];
        case "parkedTransfers":
          w.parkedReads.push({ id: args[0], blockNumber: arguments[0].blockNumber });
          // A landing without the park upgrade has no such getter: the node answers a revert.
          if (!w.parkable) throw await viemErr(LIVE_REVERT, args[0]);
          return w.parked.has(args[0])
            ? [SRC, w.parked.get(args[0])!, "0x" + "11".repeat(32)]
            : ["0x0000000000000000000000000000000000000000", 0n, "0x" + "00".repeat(32)];
        case "destAssetFor":
          return DEST;
        case "balanceOf":
          return w.pool;
        case "symbol":
          return "USDC";
        case "decimals":
          return 6;
      }
      throw new Error("unexpected read " + functionName);
    },
    async simulateContract({ functionName }: any) {
      w.reads++;
      w.calls.push("simulate:" + functionName);
      if (functionName === "parkPending" && !w.parkable) throw new Error("execution reverted");
      if (w.head >= w.tail) throw new Error("NoPendingTransfers");
      if (w.pool < w.amounts.get(w.head)!) throw new Error("InsufficientBalance");
      if (functionName !== "parkPending" && w.dispatchFails.has(w.head)) throw new Error("DispatchFailed");
      return {};
    },
    async getBlockNumber() {
      return w.block;
    },
    async getStorageAt({ slot }: any) {
      assert.equal(slot, ERC1967_IMPL_SLOT);
      return "0x" + (w.parkable ? IMPL_V2 : IMPL_V1).slice(2).padStart(64, "0");
    },
    async getCode({ address }: any) {
      if (w.codeFails) throw new Error("code read failed");
      return CODE[address];
    },
    async getBlock() {
      return { baseFeePerGas: null };
    },
    async getGasPrice() {
      return 1n;
    },
    async waitForTransactionReceipt({ hash }: any) {
      w.reads++;
      await w.onWait(hash);
      if (w.replaceWith) {
        const r = w.replaceWith(hash);
        if (r) return r;
      }
      const r = w.receipts.get(hash);
      if (!r) throw new Error("timeout");
      return r;
    },
    async getTransactionReceipt({ hash }: any) {
      w.reads++;
      const r = w.receipts.get(hash);
      if (!r) throw new Error("not found");
      return r;
    },
  };
  const wallet: any = {
    chain: { id: 222222, name: "hydration" },
    async writeContract({ functionName }: any) {
      const hash = "0x" + (++n).toString(16).padStart(64, "0");
      w.sends.push({ hash, headAtSend: w.head, fn: functionName });
      w.calls.push("write:" + functionName);
      w.onSend(hash, functionName);
      return hash;
    },
  };
  let nonce = 0;
  const queue: any = {
    async add(task: any) {
      await task.submit(nonce++);
    },
  };
  return { w, clients: { publicClient, wallet, account: { address: "0x01" } } as any, queue };
}

function keeperFor(env: ReturnType<typeof world>, clock: { t: number }, extra: any = {}) {
  const posts: string[] = [];
  const k = createPayoutKeeper({
    clients: env.clients,
    queue: env.queue,
    landing: LANDING,
    alertAfterMs: 30 * MIN,
    receiptTimeoutMs: 1,
    notify: async (m) => void posts.push(m),
    now: () => clock.t,
    ...extra,
  });
  return { k, posts };
}

const backlogWarns = (posts: string[]) => posts.filter((p) => p.startsWith("WARN queued Basejump backlog"));
const backlogOks = (posts: string[]) => posts.filter((p) => p.startsWith("OK queued Basejump backlog"));
const headWarns = (posts: string[]) => posts.filter((p) => p.includes("head-blocking"));
const distinctHeads = (e: ReturnType<typeof world>) =>
  new Set(e.w.sends.map((s) => s.headAtSend)).size === e.w.sends.length;
const ageOf = (p: string) => Number(/queued (\d+) min since/.exec(p)?.[1]);

// ── Money rows ──

test("S1 one poke, no concurrent poke: sends = maxPerRun (10), one per head", async () => {
  const e = world();
  for (let i = 0; i < 25; i++) e.w.enqueue(2_000_000n);
  e.w.pool = 100_000_000n;
  const { k } = keeperFor(e, { t: 0 });
  await k.poke();
  assert.equal(e.w.sends.length, 10);
  assert.equal(e.w.head, 10n);
  assert.ok(distinctHeads(e));
});

test("S1b pokes landing during the round: the cap is per round (25 sends), still one per head", async () => {
  const e = world();
  for (let i = 0; i < 25; i++) e.w.enqueue(2_000_000n);
  e.w.pool = 100_000_000n;
  const { k } = keeperFor(e, { t: 0 });
  e.w.onWait = async () => void k.poke();
  await k.poke();
  assert.equal(e.w.sends.length, 25);
  assert.equal(e.w.head, 25n);
  assert.ok(distinctHeads(e));
});

test("S2 stale head read after own success ends the round; the next poke continues", async () => {
  const e = world();
  for (let i = 0; i < 3; i++) e.w.enqueue(2_000_000n);
  e.w.pool = 100_000_000n;
  const { k } = keeperFor(e, { t: 0 });
  e.w.onSend = (h) => {
    e.w.mine(h);
    e.w.staleHead = e.w.head - 1n; // next read lags one block
  };
  await k.poke();
  assert.equal(e.w.sends.length, 1);
  assert.equal(e.w.head, 1n);
  e.w.onSend = (h) => e.w.mine(h);
  await k.poke();
  assert.equal(e.w.sends.length, 3);
  assert.equal(e.w.head, 3n);
});

test("S3 a third party pays the head first: ours pays the next, 2 sends clear 3", async () => {
  const e = world();
  for (let i = 0; i < 3; i++) e.w.enqueue(2_000_000n);
  e.w.pool = 100_000_000n;
  const { k } = keeperFor(e, { t: 0 });
  let first = true;
  e.w.onSend = (h) => {
    if (first) {
      first = false;
      e.w.exec(); // third party's fulfillPending lands first
    }
    e.w.mine(h);
  };
  await k.poke();
  assert.equal(e.w.sends.length, 2);
  assert.equal(e.w.head, 3n);
});

test("S3b race lost, then a short pool: 1 send over 20 pokes", async () => {
  const e = world();
  for (let i = 0; i < 3; i++) e.w.enqueue(2_000_000n);
  e.w.pool = 3_000_000n;
  const { k } = keeperFor(e, { t: 0 });
  let first = true;
  e.w.onSend = (h) => {
    if (first) {
      first = false;
      e.w.exec();
    }
    e.w.mine(h);
  };
  for (let i = 0; i < 20; i++) await k.poke();
  assert.equal(e.w.sends.length, 1);
  assert.equal(e.w.head, 1n);
});

test("S4 a replacement receipt (other hash, success) is not progress: round ends after 1 send", async () => {
  const e = world();
  for (let i = 0; i < 3; i++) e.w.enqueue(2_000_000n);
  e.w.pool = 100_000_000n;
  const { k } = keeperFor(e, { t: 0 });
  e.w.onSend = () => {}; // ours never mines
  e.w.replaceWith = () => ({ transactionHash: "0x" + "ee".repeat(32), status: "success", blockNumber: 1n });
  await k.poke();
  assert.equal(e.w.sends.length, 1);
});

test("S5 an unmined send: 1 send over 51 pokes, 5 reads per poke", async () => {
  const e = world();
  for (let i = 0; i < 3; i++) e.w.enqueue(2_000_000n);
  e.w.pool = 100_000_000n;
  const { k } = keeperFor(e, { t: 0 });
  e.w.onSend = () => {};
  await k.poke();
  const r0 = e.w.reads;
  for (let i = 0; i < 50; i++) await k.poke();
  assert.equal(e.w.sends.length, 1);
  assert.equal((e.w.reads - r0) / 50, 5);
});

test("S6 an unpayable head (dispatch fails) behind a funded pool, landing without parkPending: 0 sends over 50 pokes", async () => {
  const e = world();
  for (let i = 0; i < 5; i++) e.w.enqueue(2_000_000n);
  e.w.pool = 100_000_000n;
  e.w.dispatchFails.add(0n);
  const { k } = keeperFor(e, { t: 0 });
  const r0 = e.w.reads;
  for (let i = 0; i < 50; i++) await k.poke();
  assert.equal(e.w.sends.length, 0);
  // per poke: head, tail, entry, route, balance, simulate fulfillPending, simulate parkPending
  assert.equal(e.w.reads - r0, 352);
});

test("S7 a success, then an on-chain revert of the next head ends the round at 2 sends", async () => {
  const e = world();
  for (let i = 0; i < 4; i++) e.w.enqueue(2_000_000n);
  e.w.pool = 100_000_000n;
  const { k } = keeperFor(e, { t: 0 });
  let c = 0;
  e.w.onSend = (h) => {
    if (++c === 2) e.w.pool = 0n; // a delivery spends the float between simulate and inclusion
    e.w.mine(h);
    if (c === 2) e.w.pool = 100_000_000n;
  };
  await k.poke();
  assert.equal(e.w.sends.length, 2);
  assert.equal(e.w.head, 1n);
});

test("S11 receipt not seen in-pass, later mined reverted: the next poke observes it and pays", async () => {
  const e = world();
  e.w.enqueue(2_000_000n);
  e.w.pool = 100_000_000n;
  const { k } = keeperFor(e, { t: 0 });
  const held: string[] = [];
  e.w.onSend = (h) => void held.push(h);
  await k.poke();
  // mine it as a revert (a delivery spent the float), then refill
  e.w.pool = 0n;
  e.w.mine(held[0]);
  e.w.pool = 100_000_000n;
  e.w.onSend = (h) => e.w.mine(h);
  await k.poke();
  assert.equal(e.w.sends.length, 2);
  assert.equal(e.w.head, 1n);
});

test("S13 queue.add rejects after the send went out: no second send while unobserved", async () => {
  const e = world();
  for (let i = 0; i < 3; i++) e.w.enqueue(2_000_000n);
  e.w.pool = 100_000_000n;
  const { k } = keeperFor(e, { t: 0 });
  e.w.onSend = () => {}; // never observed mined
  let nonce = 0;
  e.queue.add = async (task: any) => {
    await task.submit(nonce++);
    throw new Error("unproven");
  };
  for (let i = 0; i < 30; i++) await k.poke();
  assert.equal(e.w.sends.length, 1);
  e.w.mine(e.w.sends[0].hash);
  e.w.onSend = (h) => e.w.mine(h);
  for (let i = 0; i < 10; i++) await k.poke();
  assert.equal(e.w.sends.length, 3);
  assert.equal(e.w.head, 3n);
  assert.ok(distinctHeads(e));
});

// ── Alert table, row head `waiting` ──

test("S8 waiting: counted from this process's first sighting; backlog held back; OK when paid", async () => {
  const e = world();
  e.w.enqueue(2_000_000n);
  e.w.enqueue(2_000_000n);
  e.w.pool = 0n;
  const clock = { t: 0 };
  const A = keeperFor(e, clock);
  for (clock.t = 0; clock.t <= 25 * MIN; clock.t += MIN) await A.k.poke();
  const B = keeperFor(e, clock);
  let postsAt55 = -1;
  for (clock.t = 26 * MIN; clock.t <= 56 * MIN; clock.t += MIN) {
    await B.k.poke();
    if (clock.t === 55 * MIN) postsAt55 = B.posts.length;
  }
  assert.equal(A.posts.length, 0);
  assert.equal(postsAt55, 0);
  assert.equal(B.posts.length, 1);
  assert.match(B.posts[0], /^WARN queued Basejump payout #0 .* head-blocking for 30 min .*the pool holds 0 USDC/);
  assert.equal(backlogWarns(B.posts).length, 0);
  e.w.pool = 2_000_000n;
  clock.t += MIN;
  await B.k.poke();
  assert.equal(B.posts[1], "OK queued Basejump payout #0 paid (head now 1)");
});

test("S8b crash loop every 26 min for 24 h, pool short: 0 posts", async () => {
  const e2 = world();
  e2.w.enqueue(2_000_000n);
  e2.w.pool = 0n;
  const c2 = { t: 0 };
  let total = 0;
  for (let start = 0; start < 24 * 60 * MIN; start += 26 * MIN) {
    const P = keeperFor(e2, c2);
    for (c2.t = start; c2.t <= start + 25 * MIN; c2.t += MIN) await P.k.poke();
    total += P.posts.length;
  }
  assert.equal(total, 0);
});

test("S9 waiting, dispatch fails, landing without parkPending: 1 post in 24 h with 145 entries arriving behind it", async () => {
  const e = world();
  e.w.enqueue(2_000_000n);
  e.w.pool = 100_000_000n;
  e.w.dispatchFails.add(0n);
  const clock = { t: 0 };
  const { k, posts } = keeperFor(e, clock);
  for (clock.t = 0; clock.t <= 24 * 60 * MIN; clock.t += MIN) {
    if (clock.t % (10 * MIN) === 0) e.w.enqueue(2_000_000n);
    await k.poke();
  }
  assert.equal(posts.length, 1);
  assert.match(posts[0], /head-blocking for 30 min .*DispatchFailed/);
  assert.equal(e.w.tail - e.w.head, 146n);
});

test("B1 waiting, own send has no receipt: 1 post at 30 min at the head, never a second send", async () => {
  const e = world();
  e.w.enqueue(2_000_000n);
  e.w.pool = 100_000_000n;
  e.w.onSend = () => {};
  const clock = { t: 0 };
  const { k, posts } = keeperFor(e, clock);
  for (clock.t = 0; clock.t <= 120 * MIN; clock.t += MIN) await k.poke();
  assert.equal(e.w.sends.length, 1);
  assert.equal(posts.length, 1);
  assert.match(posts[0], /head-blocking for 30 min .*not seen mined/);
});

// ── Alert table, row head `reverting` ──

test("S8d reverting has no clock: crash loop every 26 min, every send reverts: 56 posts, one per process", async () => {
  const e = world();
  e.w.enqueue(2_000_000n);
  e.w.pool = 100_000_000n;
  e.w.onSend = (h) => {
    e.w.pool = 0n;
    e.w.mine(h);
    e.w.pool = 100_000_000n;
  };
  const c = { t: 0 };
  const all: string[] = [];
  let processes = 0;
  for (let start = 0; start < 24 * 60 * MIN; start += 26 * MIN) {
    processes++;
    const P = keeperFor(e, c);
    for (c.t = start; c.t <= start + 25 * MIN; c.t += MIN) await P.k.poke();
    assert.equal(P.posts.length, 1);
    all.push(...P.posts);
  }
  assert.equal(processes, 56);
  assert.equal(all.length, 56);
  assert.equal(headWarns(all).length, 56);
  assert.match(all[0], /head-blocking for 3 min .*3 fulfillPending calls simulated clean, then reverted/);
});

test("B2 reverting in one process for 24 h: 1 post, pauses 30, 60, 120, 240, then 360 min; OK when paid", async () => {
  const e = world();
  e.w.enqueue(2_000_000n);
  e.w.pool = 100_000_000n;
  let losing = true;
  e.w.onSend = (h) => {
    if (losing) e.w.pool = 0n;
    e.w.mine(h);
    e.w.pool = 100_000_000n;
  };
  const clock = { t: 0 };
  const { k, posts } = keeperFor(e, clock);
  const sendAt: number[] = [];
  for (clock.t = 0; clock.t <= 24 * 60 * MIN; clock.t += MIN) {
    const n = e.w.sends.length;
    await k.poke();
    for (let i = n; i < e.w.sends.length; i++) sendAt.push(clock.t / MIN);
  }
  assert.equal(posts.length, 1);
  // three reverts per window, one per poke; the cap is seen on the poke after the third, and the
  // pause runs from there
  const windows = sendAt.filter((_, i) => i % 3 === 0);
  const gaps = windows.slice(1).map((t, i) => t - (windows[i] + 3));
  assert.deepEqual(gaps.slice(0, 5), [30, 60, 120, 240, 360]);
  assert.ok(gaps.slice(5).every((g) => g === 360));
  losing = false;
  for (let i = 0; i < 400; i++) {
    clock.t += MIN;
    await k.poke();
  }
  assert.equal(e.w.head, 1n);
  assert.equal(posts.length, 2);
  assert.equal(posts[1], "OK queued Basejump payout #0 paid (head now 1)");
});

// ── Alert table, row backlog ──

test("S8c backlog first post at a first-seen age of 30 min after a restart (true age 56)", async () => {
  const e = world();
  e.w.enqueue(2_000_000n);
  e.w.enqueue(2_000_000n);
  e.w.pool = 0n;
  const clock = { t: 0 };
  const A = keeperFor(e, clock);
  for (clock.t = 0; clock.t <= 25 * MIN; clock.t += MIN) await A.k.poke();
  const B = keeperFor(e, clock);
  let at = -1;
  for (clock.t = 26 * MIN; clock.t <= 70 * MIN; clock.t += MIN) {
    if (clock.t === 50 * MIN) e.w.pool = 2_000_000n;
    const n = backlogWarns(B.posts).length;
    await B.k.poke();
    if (at < 0 && backlogWarns(B.posts).length > n) at = clock.t / MIN;
  }
  const bl = backlogWarns(B.posts);
  assert.equal(bl.length, 1);
  assert.equal(at, 56);
  assert.equal(
    bl[0],
    "WARN queued Basejump backlog on landing `0x00000000000000000000000000000000000000aa`: " +
      "oldest payout #1 queued 30 min since this keeper process first saw it, 1 queued, " +
      "next re-alert age 60 min.",
  );
});

test("S10 steady arrivals, each paid at 31 min: 1 WARN, 0 OK in 2 h (no flapping)", async () => {
  const e = world();
  const clock = { t: 0 };
  const { k, posts } = keeperFor(e, clock);
  const queuedAt = new Map<bigint, number>();
  for (clock.t = 0; clock.t <= 120 * MIN; clock.t += MIN) {
    if (clock.t % (2 * MIN) === 0) {
      queuedAt.set(e.w.tail, clock.t);
      e.w.enqueue(1n);
    }
    const ha = queuedAt.get(e.w.head);
    e.w.pool = ha !== undefined && clock.t - ha >= 31 * MIN ? 1n : 0n;
    await k.poke();
  }
  assert.equal(backlogWarns(posts).length, 1);
  assert.equal(backlogOks(posts).length, 0);
});

test("S12 OK when the queue empties, none in a 3 h band at 20 min, and a later 40-min stall alerts again", async () => {
  const e = world();
  const clock = { t: 0 };
  const { k, posts } = keeperFor(e, clock);
  for (let i = 0; i < 40; i++) e.w.enqueue(1n); // all first seen at t=0
  await k.poke();
  clock.t = 31 * MIN;
  e.w.pool = 0n;
  await k.poke();
  const qAt = new Map<bigint, number>();
  for (let id = 0n; id < 40n; id++) qAt.set(id, 0);
  e.w.pool = 40n; // pay all 40 originals now
  await k.poke();
  await k.poke();
  await k.poke();
  await k.poke();
  await k.poke();
  e.w.pool = 0n;
  for (clock.t = 32 * MIN; clock.t <= 32 * MIN + 180 * MIN; clock.t += MIN) {
    qAt.set(e.w.tail, clock.t);
    e.w.enqueue(1n);
    const ha = qAt.get(e.w.head);
    e.w.pool = ha !== undefined && clock.t - ha >= 20 * MIN ? 1n : 0n; // each paid at 20 min (in band)
    await k.poke();
  }
  assert.equal(backlogOks(posts).length, 1);
  assert.match(backlogOks(posts)[0], /cleared \(queue empty\)$/);
  e.w.pool = 0n;
  for (let j = 0; j < 40; j++) {
    clock.t += MIN;
    await k.poke();
  }
  assert.equal(backlogWarns(posts).length, 2);
  assert.equal(headWarns(posts).length, 2);
});

test("S12c a worse stall after an outstanding WARN re-alerts at the doublings (2 posts, oldest 169 min)", async () => {
  const e = world();
  const clock = { t: 0 };
  const { k, posts } = keeperFor(e, clock);
  const qAt = new Map<bigint, number>();
  const step = async (cover: (age: number) => boolean) => {
    clock.t += MIN;
    qAt.set(e.w.tail, clock.t);
    e.w.enqueue(1n);
    let n = 0n;
    for (let id = e.w.head; id < e.w.tail; id++) {
      const q = qAt.get(id)!;
      if (cover(clock.t - q)) n++;
      else break;
    }
    e.w.pool = n;
    await k.poke();
  };
  for (let j = 0; j < 60; j++) await step((a) => a >= 31 * MIN);
  for (let j = 0; j < 180; j++) await step((a) => a >= 20 * MIN);
  const p0 = posts.length;
  let maxAge = 0;
  for (let j = 0; j < 240; j++) {
    const refill = j % 25 === 0;
    await step((a) => refill && a >= 35 * MIN);
    const q = qAt.get(e.w.head);
    if (q !== undefined) maxAge = Math.max(maxAge, clock.t - q);
  }
  const phase = posts.slice(p0);
  assert.equal(maxAge, 169 * MIN);
  assert.equal(phase.length, 2);
  assert.deepEqual(backlogWarns(phase).map(ageOf), [60, 120]);
  assert.equal(backlogWarns(posts).length, 3);
});

/**
 * Advisor world: an entry every 5 min, each head paid 25 min after it reached the head (so no
 * head alert), so the oldest first-seen age grows without bound.
 */
async function advisorWorld(restartAt: number | undefined, endAt: number) {
  const e = world();
  const clock = { t: 0 };
  const queuedAt = new Map<bigint, number>();
  const procs = [keeperFor(e, clock)];
  let headSince = 0;
  let lastHead = 0n;
  const at: { t: number; trueAge: number; post: string }[] = [];
  for (clock.t = 0; clock.t <= endAt * MIN; clock.t += MIN) {
    if (restartAt !== undefined && clock.t === restartAt * MIN) procs.push(keeperFor(e, clock));
    if (clock.t % (5 * MIN) === 0) {
      queuedAt.set(e.w.tail, clock.t);
      e.w.enqueue(1n);
    }
    if (e.w.head !== lastHead) {
      lastHead = e.w.head;
      headSince = clock.t;
    }
    e.w.pool = clock.t - headSince >= 25 * MIN ? 1n : 0n;
    const P = procs[procs.length - 1];
    const n = P.posts.length;
    await P.k.poke();
    for (const post of P.posts.slice(n)) {
      at.push({ t: clock.t / MIN, trueAge: (clock.t - queuedAt.get(e.w.head)!) / MIN, post });
    }
  }
  return { at, posts: procs.flatMap((p) => p.posts) };
}

test("A1 doubling: backlog posts at oldest ages 30, 60, 120, 240 min; no head alert", async () => {
  const { at, posts } = await advisorWorld(undefined, 300);
  assert.deepEqual(backlogWarns(posts).map(ageOf), [30, 60, 120, 240]);
  assert.equal(headWarns(posts).length, 0);
  assert.deepEqual(
    at.map((x) => /next re-alert age (\d+) min/.exec(x.post)?.[1]).map(Number),
    [60, 120, 240, 480],
  );
});

test("A2 restart at 45 min: no post at the promised 60 min; the new process's first says 30 min at a true 65", async () => {
  const { at, posts } = await advisorWorld(45, 120);
  assert.equal(headWarns(posts).length, 0);
  assert.equal(at[0].t, 35);
  assert.equal(ageOf(at[0].post), 30);
  assert.match(at[0].post, /next re-alert age 60 min/);
  // the new process (from 45) posts nothing until 75, when its count reaches 30 min
  assert.equal(at[1].t, 75);
  assert.match(at[1].post, /oldest payout #2 queued 30 min since/);
  assert.equal(at[1].trueAge, 65);
});

test("B3 an age that jumps past several doublings gives one post; the next waits for the next doubling", async () => {
  const e = world();
  const c = { t: 0 };
  const { k, posts } = keeperFor(e, c);
  for (let i = 0; i < 6; i++) e.w.enqueue(1n);
  await k.poke();
  c.t = 150 * MIN;
  e.w.pool = 1n;
  await k.poke(); // pays #0; #1 is a fresh head, 150 min since first seen
  for (let j = 0; j < 10; j++) {
    c.t += MIN;
    await k.poke();
  }
  assert.equal(backlogWarns(posts).length, 1);
  // move the head every 20 min so no head alert holds the backlog post back
  for (const t of [170, 190, 210, 230]) {
    c.t = t * MIN;
    e.w.pool = 1n;
    await k.poke();
  }
  c.t = 239 * MIN;
  await k.poke();
  assert.equal(backlogWarns(posts).length, 1);
  c.t = 240 * MIN;
  await k.poke();
  assert.deepEqual(backlogWarns(posts).map(ageOf), [150, 240]);
  assert.equal(headWarns(posts).length, 0);
});

test("B4 a re-post is held back while a head alert is out for the oldest entry", async () => {
  const e = world();
  const c = { t: 0 };
  const { k, posts } = keeperFor(e, c);
  for (let i = 0; i < 3; i++) e.w.enqueue(1n);
  await k.poke();
  c.t = 20 * MIN;
  e.w.pool = 1n;
  await k.poke(); // pays #0 at 20; #1 heads, first seen at 0
  e.w.pool = 0n;
  for (c.t = 21 * MIN; c.t <= 200 * MIN; c.t += MIN) await k.poke();
  // #1: backlog at age 30 (head 10 min), then head alert at 50 (head 30 min); age 60, 120 pass held
  assert.deepEqual(backlogWarns(posts).map(ageOf), [30]);
  assert.equal(headWarns(posts).length, 1);
  assert.match(headWarns(posts)[0], /payout #1 .*head-blocking for 30 min/);
});

test("B5 OK when the oldest age falls below 15 min with the queue not empty", async () => {
  const e = world();
  const c = { t: 0 };
  const { k, posts } = keeperFor(e, c);
  e.w.enqueue(1n);
  e.w.enqueue(1n);
  await k.poke();
  c.t = 20 * MIN;
  e.w.pool = 1n;
  await k.poke(); // pays #0; #1 heads at 20, first seen at 0
  e.w.pool = 0n;
  for (c.t = 21 * MIN; c.t <= 31 * MIN; c.t += MIN) await k.poke();
  assert.deepEqual(backlogWarns(posts).map(ageOf), [30]);
  e.w.enqueue(1n); // #2, first seen at 31
  for (c.t = 32 * MIN; c.t <= 34 * MIN; c.t += MIN) await k.poke();
  c.t = 35 * MIN;
  e.w.pool = 1n;
  await k.poke(); // pays #1; #2 first seen at 32, so 3 min old
  assert.equal(e.w.tail - e.w.head, 1n);
  assert.deepEqual(backlogOks(posts), [
    "OK queued Basejump backlog on landing `0x00000000000000000000000000000000000000aa` cleared (oldest payout #2 is 3 min old)",
  ]);
  assert.equal(headWarns(posts).length, 0);
});

// ── Park rows (the FIFO / park landing) ──

const parkWarns = (posts: string[]) => posts.filter((p) => / parked on landing /.test(p));

test("P1 a funded head whose dispatch fails is parked once, the 4 behind it are paid; 1 park alert; never fulfillParked", async () => {
  const e = world();
  e.w.parkable = true;
  for (let i = 0; i < 5; i++) e.w.enqueue(2_000_000n);
  e.w.pool = 100_000_000n;
  e.w.dispatchFails.add(0n);
  const clock = { t: 0 };
  const { k, posts } = keeperFor(e, clock);
  await k.poke();
  assert.equal(e.w.sends.length, 1); // a park ends the round
  for (let i = 0; i < 50; i++) {
    clock.t += MIN;
    await k.poke();
  }
  assert.deepEqual(
    e.w.sends.map((s) => [s.fn, s.headAtSend]),
    [
      ["parkPending", 0n],
      ["fulfillPending", 1n],
      ["fulfillPending", 2n],
      ["fulfillPending", 3n],
      ["fulfillPending", 4n],
    ],
  );
  assert.equal(e.w.head, 5n);
  assert.deepEqual([...e.w.parked.keys()], [0n]);
  assert.equal(e.w.pool, 92_000_000n); // the parked 2 USDC stays in the pool
  assert.deepEqual(posts, [
    "WARN queued Basejump payout #0 of 2 USDC (asset 21) parked on landing " +
      "`0x00000000000000000000000000000000000000aa`: parkedTransfers(0) holds it, recipient 0x" +
      "11".repeat(32) +
      ", by this keeper's parkPending 0x" +
      "1".padStart(64, "0") +
      " with the pool holding 100 USDC (asset 21).",
  ]);
  assert.ok(!e.w.calls.some((c) => c.includes("fulfillParked")));
});

test("P2 a head whose dispatch fails is never parked while the pool is short; parked once funded", async () => {
  const e = world();
  e.w.parkable = true;
  e.w.enqueue(2_000_000n);
  e.w.enqueue(2_000_000n);
  e.w.pool = 3_000_000n - 1_000_001n; // short of the head
  e.w.dispatchFails.add(0n);
  const clock = { t: 0 };
  const { k, posts } = keeperFor(e, clock);
  for (clock.t = 0; clock.t <= 120 * MIN; clock.t += MIN) await k.poke();
  assert.deepEqual(e.w.calls.filter((c) => c.includes("parkPending")), []);
  assert.equal(e.w.sends.length, 0);
  assert.equal(headWarns(posts).length, 1);
  assert.match(headWarns(posts)[0], /payout #0 .*the pool holds 1\.999999 USDC/);
  assert.equal(parkWarns(posts).length, 0);
  e.w.pool = 4_000_000n;
  clock.t += MIN;
  await k.poke();
  clock.t += MIN;
  await k.poke();
  assert.deepEqual(e.w.sends.map((s) => s.fn), ["parkPending", "fulfillPending"]);
  assert.equal(parkWarns(posts).length, 1);
});

test("P3 parks by someone else are alerted once each from parkedTransfers; no 'paid' OK for a parked head", async () => {
  const e = world();
  e.w.parkable = true;
  for (let i = 0; i < 4; i++) e.w.enqueue(2_000_000n);
  e.w.pool = 0n;
  const clock = { t: 0 };
  const { k, posts } = keeperFor(e, clock);
  for (clock.t = 0; clock.t <= 31 * MIN; clock.t += MIN) await k.poke();
  assert.equal(headWarns(posts).length, 1); // #0 waiting
  // another caller parks #0 and #1 between two polls
  e.w.pool = 100_000_000n;
  e.w.dispatchFails.add(0n);
  e.w.dispatchFails.add(1n);
  assert.equal(e.w.exec("parkPending"), "success");
  assert.equal(e.w.exec("parkPending"), "success");
  e.w.pool = 0n;
  for (let i = 0; i < 10; i++) {
    clock.t += MIN;
    await k.poke();
  }
  const parks = parkWarns(posts);
  assert.equal(parks.length, 2);
  assert.match(parks[0], /^WARN queued Basejump payout #0 of 2 USDC \(asset 21\) parked on landing .*parkedTransfers\(0\) holds it, recipient 0x(11){32}; head then 2\.$/);
  assert.match(parks[1], /^WARN queued Basejump payout #1 .*parkedTransfers\(1\) holds it/);
  assert.ok(!posts.some((p) => p.startsWith("OK queued Basejump payout #0")));
  assert.equal(e.w.sends.length, 0);
});

test("P4 a parkPending that pays (the dispatch succeeds by inclusion): no park alert, the rest paid", async () => {
  const e = world();
  e.w.parkable = true;
  for (let i = 0; i < 3; i++) e.w.enqueue(2_000_000n);
  e.w.pool = 100_000_000n;
  e.w.dispatchFails.add(0n);
  e.w.onSend = (h, fn) => {
    e.w.dispatchFails.delete(0n); // e.g. the recipient's account was funded meanwhile
    e.w.mine(h, fn);
  };
  const { k, posts } = keeperFor(e, { t: 0 });
  for (let i = 0; i < 5; i++) await k.poke();
  assert.deepEqual(e.w.sends.map((s) => s.fn), ["parkPending", "fulfillPending", "fulfillPending"]);
  assert.equal(e.w.head, 3n);
  assert.equal(e.w.parked.size, 0);
  assert.deepEqual(posts, []);
});

test("P5 a head that left with an alert out, parkedTransfers unreadable: OK says 'left the head', not 'paid'", async () => {
  const e = world();
  e.w.parkable = true;
  e.w.enqueue(2_000_000n);
  e.w.enqueue(2_000_000n);
  e.w.pool = 0n;
  const clock = { t: 0 };
  const { k, posts } = keeperFor(e, clock);
  for (clock.t = 0; clock.t <= 31 * MIN; clock.t += MIN) await k.poke();
  const real = e.clients.publicClient.readContract;
  e.clients.publicClient.readContract = async (q: any) => {
    if (q.functionName === "parkedTransfers") throw new Error("rpc down"); // not an executed revert
    return real(q);
  };
  e.w.pool = 2_000_000n;
  e.w.exec(); // someone else pays #0
  clock.t += MIN;
  await k.poke();
  assert.deepEqual(
    posts.filter((p) => p.startsWith("OK queued Basejump payout #0")),
    ["OK queued Basejump payout #0 left the head (head now 1); parkedTransfers(0) not read"],
  );
  assert.equal(parkWarns(posts).length, 0);
});

test("P6 a landing whose code has no parkedTransfers: a head that left reads paid, and parkedTransfers is never read", async () => {
  const e = world(); // parkable false: implementation V1, no parkPending, no parkedTransfers
  e.w.enqueue(2_000_000n);
  e.w.enqueue(2_000_000n);
  e.w.pool = 0n;
  const clock = { t: 0 };
  const { k, posts } = keeperFor(e, clock);
  for (clock.t = 0; clock.t <= 31 * MIN; clock.t += MIN) await k.poke();
  e.w.pool = 2_000_000n;
  clock.t += MIN;
  await k.poke();
  assert.deepEqual(
    posts.filter((p) => p.startsWith("OK queued Basejump payout #0")),
    ["OK queued Basejump payout #0 paid (head now 1)"],
  );
  assert.deepEqual(e.w.parkedReads, []);
});

test("C1a upgraded landing, someone else parks #0, ONE parkedTransfers read fails with a node fault (-32603): 1 park alert, never 'paid'", async () => {
  for (const fault of [NODE_FAULT, LIVE_REVERT, { code: -32603, message: "Internal error" }]) {
    const e = world();
    e.w.parkable = true;
    e.w.enqueue(2_000_000n);
    e.w.enqueue(2_000_000n);
    e.w.pool = 0n;
    const clock = { t: 0 };
    const { k, posts } = keeperFor(e, clock);
    for (clock.t = 0; clock.t <= 31 * MIN; clock.t += MIN) await k.poke(); // waiting alert out on #0
    e.w.pool = 100_000_000n;
    e.w.dispatchFails.add(0n);
    assert.equal(e.w.exec("parkPending"), "success");
    e.w.pool = 0n;
    const real = e.clients.publicClient.readContract;
    let failures = 1;
    e.clients.publicClient.readContract = async (q: any) => {
      if (q.functionName === "parkedTransfers" && failures-- > 0) throw await viemErr(fault, q.args[0]);
      return real(q);
    };
    for (let i = 0; i < 20; i++) {
      clock.t += MIN;
      await k.poke();
    }
    assert.equal(parkWarns(posts).length, 1, fault.message);
    assert.ok(!posts.some((p) => p.startsWith("OK queued Basejump payout #0 paid")), fault.message);
  }
});

test("C1b own park; its receipt-block read and the next scan read both fail (-32603): the park alert still comes", async () => {
  const e = world();
  e.w.parkable = true;
  for (let i = 0; i < 3; i++) e.w.enqueue(2_000_000n);
  e.w.pool = 100_000_000n;
  e.w.dispatchFails.add(0n);
  const clock = { t: 0 };
  const { k, posts } = keeperFor(e, clock);
  const real = e.clients.publicClient.readContract;
  let failures = 2;
  e.clients.publicClient.readContract = async (q: any) => {
    if (q.functionName === "parkedTransfers" && failures-- > 0) throw await viemErr(NODE_FAULT, q.args[0]);
    return real(q);
  };
  for (let i = 0; i < 10; i++) {
    clock.t += MIN;
    await k.poke();
  }
  assert.equal(parkWarns(posts).length, 1);
});

test("P7 the implementation's code cannot be read: a head that left with an alert out reads 'not read', not 'paid'", async () => {
  const e = world(); // V1
  e.w.enqueue(2_000_000n);
  e.w.enqueue(2_000_000n);
  e.w.pool = 0n;
  e.w.codeFails = true;
  const clock = { t: 0 };
  const { k, posts } = keeperFor(e, clock);
  for (clock.t = 0; clock.t <= 31 * MIN; clock.t += MIN) await k.poke();
  e.w.pool = 2_000_000n;
  clock.t += MIN;
  await k.poke();
  assert.deepEqual(
    posts.filter((p) => p.startsWith("OK queued Basejump payout #0")),
    ["OK queued Basejump payout #0 left the head (head now 1); parkedTransfers(0) not read"],
  );
});

test("P8 an upgrade while running is decided afresh: after V1 -> V2, a park by someone else is alerted", async () => {
  const e = world();
  for (let i = 0; i < 3; i++) e.w.enqueue(2_000_000n);
  e.w.pool = 2_000_000n;
  const clock = { t: 0 };
  const { k, posts } = keeperFor(e, clock);
  await k.poke(); // pays #0 on V1
  await k.poke();
  assert.equal(e.w.head, 1n);
  e.w.parkable = true; // the TC upgrades the proxy to V2
  e.w.pool = 100_000_000n;
  e.w.dispatchFails.add(1n);
  assert.equal(e.w.exec("parkPending"), "success"); // someone else parks #1
  e.w.pool = 0n;
  for (let i = 0; i < 5; i++) {
    clock.t += MIN;
    await k.poke();
  }
  assert.equal(parkWarns(posts).length, 1);
  assert.match(parkWarns(posts)[0], /payout #1 /);
});

test("R1 a restarted process alerts each still-parked entry once from its startup scan (id 0)", async () => {
  const e = world();
  e.w.parkable = true;
  for (let i = 0; i < 3; i++) e.w.enqueue(2_000_000n);
  e.w.pool = 100_000_000n;
  e.w.dispatchFails.add(0n);
  const clock = { t: 0 };
  const A = keeperFor(e, clock);
  for (let i = 0; i < 5; i++) await A.k.poke();
  assert.equal(parkWarns(A.posts).length, 1);
  const B = keeperFor(e, clock); // restart
  for (let i = 0; i < 20; i++) {
    clock.t += MIN;
    await B.k.poke();
  }
  assert.equal(parkWarns(B.posts).length, 1);
  assert.match(parkWarns(B.posts)[0], /^WARN queued Basejump payout #0 .*parkedTransfers\(0\) holds it.*; head then 3\.$/);
});

test("R9 a parked entry later paid by fulfillParked posts nothing (the parked row is never cleared)", async () => {
  const e = world();
  e.w.parkable = true;
  for (let i = 0; i < 2; i++) e.w.enqueue(2_000_000n);
  e.w.pool = 100_000_000n;
  e.w.dispatchFails.add(0n);
  const clock = { t: 0 };
  const { k, posts } = keeperFor(e, clock);
  for (let i = 0; i < 5; i++) await k.poke();
  const n = posts.length;
  assert.equal(parkWarns(posts).length, 1);
  e.w.parked.delete(0n); // someone's fulfillParked(0) pays it
  for (let i = 0; i < 20; i++) {
    clock.t += MIN;
    await k.poke();
  }
  assert.equal(posts.length, n);
});

test("R3 the keeper's own park is read back at its receipt's block", async () => {
  const e = world();
  e.w.parkable = true;
  e.w.enqueue(2_000_000n);
  e.w.pool = 100_000_000n;
  e.w.dispatchFails.add(0n);
  const { k } = keeperFor(e, { t: 0 });
  await k.poke();
  const rcptBlock = e.w.receipts.get(e.w.sends[0].hash)!.blockNumber;
  e.w.block += 5n; // later blocks exist when the read is made
  assert.deepEqual(e.w.parkedReads[0], { id: 0n, blockNumber: rcptBlock });
});
