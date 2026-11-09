/**
 * The nonce lane under a load balancer: nodes with SEPARATE mempools over one chain, a contract that
 * records each message once (a second delivery reverts, gas burnt), and simulate before send, like
 * clients/hydration.ts `submit`. A node refuses a second send at a nonce it already holds
 * ("already known" / "replacement transaction underpriced"), as geth-style pools do.
 *
 * Run: `pnpm test` in agents/relayer.
 */
import assert from "node:assert/strict";
import test from "node:test";

import * as winston from "winston";
import {
  ContractFunctionRevertedError,
  encodeErrorResult,
  parseAbi,
  type Account,
  type Hash,
  type PublicClient,
  type TransactionReceipt,
} from "viem";

import { createQueue, type Task } from "./queue";

const silent = winston.createLogger({ silent: true });
const ADDRESS = `0x${"11".repeat(20)}` as const;
const abi = parseAbi(["error MessageAlreadyProcessed()", "error Error(string)"]);

function revert(errorName: "MessageAlreadyProcessed"): Error {
  return new ContractFunctionRevertedError({
    abi,
    data: encodeErrorResult({ abi, errorName }),
    functionName: "receiveMessage",
  });
}
function revertReason(reason: string): Error {
  const errAbi = parseAbi(["function x()"]);
  return new ContractFunctionRevertedError({
    abi: errAbi,
    // Error(string) selector 0x08c379a0
    data: encodeErrorResult({ abi: parseAbi(["error Error(string)"]), errorName: "Error", args: [reason] }),
    functionName: "x",
  });
}

type Tx = { hash: Hash; nonce: number; msg: string; fee: number };

class Net {
  mined = 7;
  nodes: Map<Hash, Tx>[] = [new Map(), new Map()];
  /** Which node answers reads / takes sends (a load balancer). */
  readNode = 0;
  sendNode = 0;
  receipts = new Map<Hash, TransactionReceipt>();
  delivered = new Map<string, number>();
  reverted: string[] = [];
  sends: Tx[] = [];
  minedTx = new Map<number, Tx>();
  onWait: (hash: Hash, call: number) => void | Promise<void> = () => {};
  waits = 0;
  private serial = 0;
  fee = 1;

  find(hash: Hash): Tx | undefined {
    for (const n of this.nodes) if (n.has(hash)) return n.get(hash);
    return this.sends.find((s) => s.hash === hash);
  }

  send(msg: string, nonce: number): Hash {
    // simulate on the read node's view of contract state (shared chain state here)
    if ((this.delivered.get(msg) ?? 0) > 0) throw revert("MessageAlreadyProcessed");
    if (nonce < this.mined) throw new Error("nonce too low");
    const node = this.nodes[this.sendNode];
    for (const tx of node.values()) {
      if (tx.nonce === nonce && tx.msg === msg && tx.fee === this.fee) throw new Error("already known");
      if (tx.nonce === nonce && this.fee < tx.fee * 1.1) throw new Error("replacement transaction underpriced");
    }
    for (const [h, tx] of node) if (tx.nonce === nonce) node.delete(h);
    const hash = `0x${(++this.serial).toString(16).padStart(64, "0")}` as Hash;
    const tx = { hash, nonce, msg, fee: this.fee };
    node.set(hash, tx);
    this.sends.push(tx);
    return hash;
  }

  mine(hash: Hash): void {
    const tx = this.find(hash)!;
    assert.equal(tx.nonce, this.mined, `mining ${hash} at ${tx.nonce} with chain at ${this.mined}`);
    for (const n of this.nodes) for (const [h, t] of n) if (t.nonce === tx.nonce) n.delete(h);
    this.mined++;
    this.minedTx.set(tx.nonce, tx);
    const done = (this.delivered.get(tx.msg) ?? 0) > 0;
    if (done) this.reverted.push(tx.msg);
    else this.delivered.set(tx.msg, 1);
    this.receipts.set(hash, { transactionHash: hash, status: done ? "reverted" : "success" } as TransactionReceipt);
  }

  /** Real-node pending count: mined plus the CONTIGUOUS run of this node's pool from `mined`. */
  pendingCount(): number {
    const nonces = new Set([...this.nodes[this.readNode].values()].map((t) => t.nonce));
    let p = this.mined;
    while (nonces.has(p)) p++;
    return p;
  }

  client(): PublicClient {
    return {
      getChainId: async () => 8453,
      getBalance: async () => 10n ** 21n,
      getGasPrice: async () => 1n,
      getTransactionCount: async ({ blockTag }: { blockTag?: string }) =>
        blockTag === "pending" ? this.pendingCount() : this.mined,
      getTransactionReceipt: async ({ hash }: { hash: Hash }) => {
        const r = this.receipts.get(hash);
        if (!r) throw new Error(`receipt ${hash} not found`);
        return r;
      },
      waitForTransactionReceipt: async ({ hash }: { hash: Hash }) => {
        await this.onWait(hash, ++this.waits);
        await new Promise((r) => setTimeout(r, 1));
        const r = this.receipts.get(hash);
        if (r) return r;
        // viem: replacement found only when the read node knows the original tx.
        const own = this.find(hash);
        if (own && this.minedTx.has(own.nonce)) {
          const m = this.minedTx.get(own.nonce)!;
          return this.receipts.get(m.hash)!;
        }
        throw new Error(`Timed out while waiting for transaction with hash "${hash}" to be confirmed.`);
      },
    } as unknown as PublicClient;
  }
}

function setup(net: Net) {
  const queue = createQueue({
    publicClient: net.client(),
    account: { address: ADDRESS } as Account,
    warnMultiplier: 1n,
    receiptTimeoutMs: 1,
    roundDelayMs: 1,
  });
  const task = (msg: string): Task => ({ label: msg, logger: silent, submit: async (n) => net.send(msg, n) });
  return { queue, task };
}
const T = { timeout: 5_000 };
const settle = <X>(p: Promise<X>) => p.then((v) => ({ ok: true as const, v }), (e) => ({ ok: false as const, e }));

test("split mempool, the read node lost the send: sent again at the same nonce, one mines, one delivery", T, async () => {
  const net = new Net();
  const { queue, task } = setup(net);
  await queue.init();
  net.onWait = (hash, call) => {
    if (call === 1) {
      net.readNode = 1; // the load balancer moves reads and sends to node B, which never saw T1
      net.sendNode = 1;
    }
    if (call === 2) net.mine(net.sends[0].hash); // T1 (on node A) mines; T2 (on B) never can
  };
  const r = await queue.add(task("A"));
  assert.deepEqual(net.sends.map((s) => `${s.msg}@${s.nonce}`), ["A@7", "A@7"]);
  assert.equal(r?.transactionHash, net.sends[0].hash, "T1's receipt is the task's outcome");
  assert.equal(net.delivered.get("A"), 1);
  assert.deepEqual(net.reverted, []);
  assert.equal(queue.nonce, 8);
});

test("the same message added twice (a stalled-job re-run): the second simulates as done", T, async () => {
  const net = new Net();
  const { queue, task } = setup(net);
  await queue.init();
  net.onWait = (hash, call) => {
    if (call === 3) net.mine(hash);
  };
  const p1 = queue.add(task("A"));
  const p2 = queue.add(task("A")); // bullmq stalled checker handed the same job to this worker again
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1?.status, "success");
  assert.equal(r2, undefined);
  assert.deepEqual(net.sends.map((s) => `${s.msg}@${s.nonce}`), ["A@7"]);
  assert.deepEqual(net.reverted, []);
});

test("restart mid-wait: a new queue starts at latest; nothing it sends can mine beside T1", T, async () => {
  const net = new Net();
  const first = setup(net);
  await first.queue.init();
  net.onWait = () => new Promise(() => {}); // process 1 dies while waiting
  void first.queue.add(first.task("A"));
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(net.sends.map((s) => `${s.msg}@${s.nonce}`), ["A@7"]);

  const net2 = net; // same chain and nodes
  net2.onWait = (hash, call) => {
    if (call === 2) net2.mine(net2.sends[0].hash); // the old T1 mines during process 2's first wait
  };
  const second = setup(net2);
  assert.equal(await second.queue.init(), 7);
  net2.fee = 2; // a fee spike: the new process's send REPLACES nothing yet (other node)
  net2.sendNode = 1;
  const rb = await settle(second.queue.add(second.task("B"))); // a different job first
  const ra = await settle(second.queue.add(second.task("A"))); // the stalled re-run of A
  net2.onWait = (hash) => net2.mine(hash);
  const rb2 = rb.ok ? rb : await settle(second.queue.add(second.task("B")));
  assert.equal(net2.delivered.get("A"), 1);
  assert.equal(net2.delivered.get("B"), 1);
  assert.deepEqual(net2.reverted, [], "no replay");
  assert.ok(ra.ok, "A's re-run resolves (done)");
  assert.ok(rb2.ok);
  const nonces = net2.sends.map((s) => `${s.msg}@${s.nonce}`);
  assert.deepEqual(nonces, ["A@7", "B@7", "B@8"]);
});

test("split mempool, the repeat send lands on the node holding the first: the lane holds, no later task is refused at n", T, async () => {
  const net = new Net();
  const { queue, task } = setup(net);
  await queue.init();
  // Reads go to node B (never saw T1); sends go to node A (holds T1), which refuses any second send
  // at 7. T1 stays pending until the test mines it.
  net.onWait = (_h, call) => {
    if (call === 1) net.readNode = 1;
  };
  let aDone = false;
  const a = settle(queue.add(task("A"))).then((r) => ((aDone = true), r));
  const b = settle(queue.add(task("B")));
  for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 2));
  assert.equal(aDone, false, "A is held, not rejected, while T1 is pending");
  assert.equal(queue.nonce, 7);
  assert.deepEqual(net.sends.map((s) => `${s.msg}@${s.nonce}`), ["A@7"], "B not handed the occupied nonce");

  net.mine(net.sends[0].hash);
  net.onWait = (hash) => net.mine(hash);
  const ra = await a;
  assert.ok(ra.ok && ra.v?.transactionHash === net.sends[0].hash, "T1's receipt is A's outcome");
  const rb = await b;
  assert.ok(rb.ok && rb.v?.status === "success");
  assert.deepEqual(net.sends.map((s) => `${s.msg}@${s.nonce}`), ["A@7", "B@8"]);
  assert.equal(net.delivered.get("A"), 1);
  assert.equal(net.delivered.get("B"), 1);
  assert.deepEqual(net.reverted, []);
});

test("a task left the lane with its send still out (repeat simulated done): the next task's refused send holds until n mines", T, async () => {
  const net = new Net();
  const { queue, task } = setup(net);
  await queue.init();
  let calls = 0;
  const a: Task = {
    label: "A",
    logger: silent,
    submit: async (n) => {
      if (++calls === 2) throw revert("MessageAlreadyProcessed"); // the repeat simulates as done
      return net.send("A", n);
    },
  };
  net.onWait = (_h, call) => {
    if (call === 1) net.readNode = 1; // B's view: neither mined nor pending
  };
  assert.equal(await queue.add(a), undefined, "A resolves as done; T1 still pending on node A");
  assert.equal(queue.nonce, 7);

  // B's first send at 7 reaches node A, which still holds T1: refused, and B must hold, not fail.
  let bDone = false;
  const b = settle(queue.add(task("B"))).then((r) => ((bDone = true), r));
  for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 2));
  assert.equal(bDone, false, "B held while 7 is occupied");
  net.mine(net.sends[0].hash);
  net.onWait = (hash) => net.mine(hash);
  const rb = await b;
  assert.ok(rb.ok && rb.v?.status === "success");
  assert.deepEqual(net.sends.map((s) => `${s.msg}@${s.nonce}`), ["A@7", "B@8"]);
});

test("a first send that fails before anything is out (RPC error, nothing at n): the task rejects, the lane is not held", T, async () => {
  const net = new Net();
  const { queue, task } = setup(net);
  await queue.init();
  const broken: Task = { label: "X", logger: silent, submit: async () => Promise.reject(new Error("fetch failed")) };
  await assert.rejects(queue.add(broken), /fetch failed/);
  net.onWait = (hash) => net.mine(hash);
  const r = await queue.add(task("B"));
  assert.equal(r?.status, "success");
  assert.deepEqual(net.sends.map((s) => `${s.msg}@${s.nonce}`), ["B@7"]);
});
