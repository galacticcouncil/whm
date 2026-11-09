/**
 * The Basejump flow's landing legs: which event sets which state, how the states rank, and which
 * row a queue-id event lands on. The rank is what the upsert compares (`flow/upsert.ts`: a state
 * replaces the row's only when its rank is higher), so the "final state" below is the highest
 * rank among the legs applied, in either order.
 *
 * Run: `pnpm test` in agents/scan (node:test through the root's tsx; no database).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { LogEvent } from "../../../types";
import { basejump } from "./flows";

const LANDING = "0x70e9b12c3b19cb5f0e59984a5866278ab69df976";

const legOf = (event: string) => {
  const legs = basejump.legs.filter((l) => (l.abi as { name?: string } | undefined)?.name === event);
  assert.equal(legs.length, 1, `exactly one leg decodes ${event}`);
  return legs[0];
};

const ev = (txHash: string) =>
  ({
    chain: "hydration",
    address: LANDING,
    ref: { txHash, logIndex: 0, blockNumber: 1 },
  }) as unknown as LogEvent;

const args = {
  id: 3n,
  sourceAsset: "0x0000000000000000000000000000000000000015",
  destAsset: "0x0000000100000000000000000000000000000015",
  recipient: `0x${"11".repeat(32)}`,
  amount: 5n,
};

/** The state a row ends in after these legs, applied in this order, under the upsert's rank rule. */
const finalState = (states: string[]) =>
  states.reduce((cur, s) => (basejump.states[s] > basejump.states[cur] ? s : cur));

test("each landing event sets its state", () => {
  assert.equal(legOf("TransferExecuted").state, "completed");
  assert.equal(legOf("TransferQueued").state, "queued");
  assert.equal(legOf("PendingTransferFulfilled").state, "fulfilled");
  assert.equal(legOf("TransferParked").state, "parked");
  assert.equal(legOf("ParkedTransferFulfilled").state, "fulfilled");
});

test("parked outranks queued, fulfilled outranks parked: a parked row reads parked until paid, in any order", () => {
  assert.equal(finalState(["initiated", "queued", "parked"]), "parked");
  assert.equal(finalState(["initiated", "parked", "queued"]), "parked");
  assert.equal(finalState(["initiated", "queued", "parked", "fulfilled"]), "fulfilled");
  assert.equal(finalState(["initiated", "fulfilled", "parked", "queued"]), "fulfilled");
  assert.deepEqual(basejump.requires?.parked, "queued");
});

test("TransferParked writes the parked ref, ParkedTransferFulfilled the fulfilled ref, both on the queue id", () => {
  const parked = legOf("TransferParked").patch(args, ev("0xaa"));
  assert.deepEqual(parked.parked, { txHash: "0xaa", logIndex: 0, blockNumber: 1 });
  assert.equal(parked.fulfilled, undefined);
  assert.equal(parked.pending_id, `${LANDING}:3`);
  const paid = legOf("ParkedTransferFulfilled").patch(args, ev("0xbb"));
  assert.deepEqual(paid.fulfilled, { txHash: "0xbb", logIndex: 0, blockNumber: 1 });
  assert.equal(paid.parked, undefined);
  assert.equal(paid.pending_id, `${LANDING}:3`);
});

test("queue-id legs find the row the queued leg tagged, else an orphan", async () => {
  const seen: unknown[][] = [];
  const db = {
    async query(sql: string, values?: unknown[]) {
      seen.push([sql, values]);
      return { rows: [{ id: "init-base-7" }], rowCount: 1 };
    },
  };
  assert.equal(await legOf("TransferParked").key(args, ev("0xaa"), db), "init-base-7");
  assert.match(String(seen[0][0]), /pending_id = \$1 AND parked IS NULL/);
  assert.deepEqual(seen[0][1], [`${LANDING}:3`]);
  assert.equal(await legOf("ParkedTransferFulfilled").key(args, ev("0xbb"), db), "init-base-7");
  assert.match(String(seen[1][0]), /pending_id = \$1 AND fulfilled IS NULL/);
  const empty = { async query() { return { rows: [], rowCount: 0 }; } };
  assert.equal(await legOf("TransferParked").key(args, ev("0xcc"), empty), "orphan-park-hydration-0xcc-0");
});

test("the transfers list's status SQL text maps a basejump row in state parked to held (text pin of db.ts)", () => {
  const sql = readFileSync(new URL("../db.ts", import.meta.url), "utf8");
  const m = /CASE WHEN b\.state IN \('completed', 'fulfilled'\) THEN 'completed'\s+WHEN b\.state IN \(([^)]*)\) THEN 'held' ELSE 'pending' END/.exec(sql);
  assert.ok(m, "the basejump status CASE has its expected shape");
  assert.deepEqual(m[1].split(",").map((x) => x.trim()), ["'queued'", "'parked'"]);
});
