/**
 * The queue's nonce lane over a fake chain: a send's hash is not its outcome, so the lane holds a
 * nonce until a transaction at that nonce is known to have mined.
 *
 * Run: `pnpm test` in agents/relayer (node:test through the root's tsx; no RPC, no Redis).
 */
import assert from "node:assert/strict";
import test from "node:test";

import * as winston from "winston";
import type { Account, Hash, PublicClient, TransactionReceipt } from "viem";

import { createQueue, type Task } from "./queue";

const silent = winston.createLogger({ silent: true });
const ADDRESS = `0x${"11".repeat(20)}` as const;

/** One wallet's view of a chain: mined count, mempool, receipts. */
class FakeChain {
  /** Mined transaction count (`latest`). */
  mined = 7;
  /** In a mempool: hash -> nonce. */
  pool = new Map<Hash, number>();
  receipts = new Map<Hash, TransactionReceipt>();
  /** Every send, in order. */
  sends: { label: string; nonce: number; hash: Hash }[] = [];
  /** Runs at the start of every receipt wait, so a test can mine or drop in between. */
  onWait: (hash: Hash, call: number) => void | Promise<void> = () => {};
  waits = 0;
  private serial = 0;

  send(label: string, nonce: number): Hash {
    if (nonce < this.mined) throw new Error("nonce too low");
    const hash = `0x${(++this.serial).toString(16).padStart(64, "0")}` as Hash;
    this.sends.push({ label, nonce, hash });
    this.pool.set(hash, nonce);
    return hash;
  }

  /** Mine `hash` (ours or foreign) at its nonce. */
  mine(hash: Hash, status: "success" | "reverted" = "success"): void {
    const nonce = this.pool.get(hash);
    assert.equal(nonce, this.mined, `mining ${hash} out of order`);
    for (const [h, n] of this.pool) if (n === nonce) this.pool.delete(h);
    this.mined++;
    this.receipts.set(hash, { transactionHash: hash, status } as TransactionReceipt);
  }

  /** A foreign transaction (an operator, a second process) at the next nonce. */
  foreign(): Hash {
    const hash = `0x${"ff".repeat(31)}${(++this.serial).toString(16).padStart(2, "0")}` as Hash;
    this.pool.set(hash, this.mined);
    return hash;
  }

  client(): PublicClient {
    const pendingCount = () => Math.max(this.mined, ...[...this.pool.values()].map((n) => n + 1));
    return {
      getChainId: async () => 8453,
      getBalance: async () => 10n ** 21n,
      getGasPrice: async () => 1n,
      getTransactionCount: async ({ blockTag }: { blockTag?: string }) =>
        blockTag === "pending" ? pendingCount() : this.mined,
      getTransactionReceipt: async ({ hash }: { hash: Hash }) => {
        const r = this.receipts.get(hash);
        if (!r) throw new Error(`receipt ${hash} not found`);
        return r;
      },
      waitForTransactionReceipt: async ({ hash }: { hash: Hash }) => {
        await this.onWait(hash, ++this.waits);
        const r = this.receipts.get(hash);
        if (r) return r;
        // viem's replacement-following: a mined transaction at the same nonce from this wallet.
        const sent = this.sends.find((s) => s.hash === hash);
        if (sent) {
          for (const [h, rr] of this.receipts) {
            const other = this.sends.find((s) => s.hash === h)?.nonce ?? this.foreignNonce.get(h);
            if (other === sent.nonce) return rr;
          }
        }
        throw new Error(`Timed out while waiting for transaction with hash "${hash}" to be confirmed.`);
      },
    } as unknown as PublicClient;
  }

  /** Nonces of mined foreign transactions, for replacement-following. */
  foreignNonce = new Map<Hash, number>();
  mineForeign(hash: Hash): void {
    this.foreignNonce.set(hash, this.pool.get(hash)!);
    this.mine(hash);
  }
}

function setup(chain: FakeChain) {
  const queue = createQueue({
    publicClient: chain.client(),
    account: { address: ADDRESS } as Account,
    warnMultiplier: 1n,
    receiptTimeoutMs: 1,
    roundDelayMs: 0,
  });
  const task = (label: string): Task => ({
    label,
    logger: silent,
    submit: async (n) => chain.send(label, n),
  });
  return { queue, task };
}

const tick = () => new Promise((r) => setImmediate(r));

test("happy path: the task gets its own receipt and the lane moves one nonce", async () => {
  const chain = new FakeChain();
  chain.onWait = (hash) => chain.mine(hash);
  const { queue, task } = setup(chain);
  assert.equal(await queue.init(), 7);

  const receipt = await queue.add(task("A"));
  assert.equal(receipt?.transactionHash, chain.sends[0].hash);
  assert.equal(queue.nonce, 8);
});

test("receipt timeout, send still pending: the lane holds the nonce, nothing is sent again", async () => {
  const chain = new FakeChain();
  const labelOf = (hash: Hash) => chain.sends.find((s) => s.hash === hash)?.label;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  chain.onWait = async (hash, call) => {
    if (labelOf(hash) === "B") return chain.mine(hash);
    // A: two waits time out while it stays pending; the third mines it, once the test lets go.
    if (call === 3) {
      await gate;
      chain.mine(hash);
    }
  };
  const { queue, task } = setup(chain);
  await queue.init();

  let aDone = false;
  const a = queue.add(task("A")).then((r) => ((aDone = true), r));
  const b = queue.add(task("B"));
  while (chain.waits < 3) await tick();
  // Two receipt timeouts in, A is still unresolved: B is not sent, and A is not sent again.
  assert.equal(aDone, false);
  assert.deepEqual(chain.sends.map((s) => `${s.label}@${s.nonce}`), ["A@7"]);
  assert.equal(queue.nonce, 7, "the lane did not move past an unmined nonce");

  release();
  const ra = await a;
  assert.equal(ra?.transactionHash, chain.sends[0].hash);
  await b;
  assert.deepEqual(
    chain.sends.map((s) => `${s.label}@${s.nonce}`),
    ["A@7", "B@8"],
    "one send per message, contiguous nonces",
  );
});

test("receipt timeout, send dropped: sent again at the SAME nonce, never past a gap", async () => {
  const chain = new FakeChain();
  chain.onWait = (hash, call) => {
    if (call === 1) chain.pool.delete(hash); // the first send leaves every mempool
    else chain.mine(hash); // the repeat mines, then B
  };
  const { queue, task } = setup(chain);
  await queue.init();

  const a = queue.add(task("A"));
  const b = queue.add(task("B"));
  const ra = await a;
  assert.equal(ra?.transactionHash, chain.sends[1].hash, "the repeat's receipt is the outcome");
  await b;
  assert.deepEqual(chain.sends.map((s) => `${s.label}@${s.nonce}`), ["A@7", "A@7", "B@8"]);
  assert.equal(queue.nonce, 9);
  assert.equal(chain.mined, 9, "no gap: every nonce the lane used mined");
});

test("receipt wait fails while the send mined: the nonce read finds this task's receipt", async () => {
  const chain = new FakeChain();
  const client = chain.client();
  // A lagging receipt wait: it throws although the transaction mined.
  client.waitForTransactionReceipt = (async ({ hash }: { hash: Hash }) => {
    if (!chain.receipts.has(hash)) chain.mine(hash);
    throw new Error("Timed out");
  }) as never;
  const queue = createQueue({
    publicClient: client,
    account: { address: ADDRESS } as Account,
    warnMultiplier: 1n,
    receiptTimeoutMs: 1,
    roundDelayMs: 0,
  });
  await queue.init();
  const r = await queue.add({ label: "A", logger: silent, submit: async (n) => chain.send("A", n) });
  assert.equal(r?.transactionHash, chain.sends[0].hash);
  assert.equal(chain.sends.length, 1, "not sent again");
  assert.equal(queue.nonce, 8);
});

test("a foreign transaction took the nonce: the task rejects, the lane moves past the spent nonce", async () => {
  const chain = new FakeChain();
  chain.onWait = (_hash, call) => {
    if (call === 1) {
      // Our send leaves the pool; a foreign transaction at the same nonce mines.
      chain.pool.clear();
      chain.mineForeign(chain.foreign());
    } else {
      chain.mine(chain.sends[chain.sends.length - 1].hash);
    }
  };
  const { queue, task } = setup(chain);
  await queue.init();

  await assert.rejects(queue.add(task("A")), /nonce 7 was taken by/);
  assert.equal(queue.nonce, 8);
  // The engine's retry of A goes out at the next nonce only now that nothing A sent can mine.
  const r = await queue.add(task("A"));
  assert.equal(r?.transactionHash, chain.sends[1].hash);
  assert.deepEqual(chain.sends.map((s) => `${s.label}@${s.nonce}`), ["A@7", "A@8"]);
});

test("a reverted receipt is handed to the caller, not hidden", async () => {
  const chain = new FakeChain();
  chain.onWait = (hash) => chain.mine(hash, "reverted");
  const { queue, task } = setup(chain);
  await queue.init();
  const r = await queue.add(task("A"));
  assert.equal(r?.status, "reverted");
  assert.equal(queue.nonce, 8, "a reverted transaction still spent its nonce");
});
