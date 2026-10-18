import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha2";
import { base58 } from "@scure/base";

import { parseNttTransfer } from "../../ingest/payload";
import { vaaId } from "../../ingest/vaa";
import type { NearEvent } from "../../types";
import {
  NTT_QUEUED,
  NTT_RECEIVED,
  NTT_RELEASED,
  PUBLISH,
  type NttReceived,
  type NttSettled,
  type Publish,
} from "../events";

import { CORE_POSTS, PER_INSTRUCTION, TOKEN_PAYOUTS, TOKEN_PROGRAMS } from "./consts";
import type { Instruction, RawInstruction, Tx } from "./types";

/**
 * Anchor's instruction discriminator: the first eight bytes of `sha256("global:<name>")`.
 *
 * @param name The instruction, as the program names it.
 */
const discriminator = (name: string) =>
  Buffer.from(sha256(new TextEncoder().encode(`global:${name}`)).subarray(0, 8)).toString("hex");

/** The NTT instructions a transfer's delivery runs through, by discriminator. */
const RECEIVE = discriminator("receive_wormhole_message");
const RECEIVE_DATA = discriminator("receive_wormhole_message_instruction_data");
const RELEASES = new Set([
  discriminator("release_inbound_unlock"),
  discriminator("release_inbound_mint"),
]);

/** A decoded event, before the watcher makes it a row. */
export interface Decoded {
  /** The program it is stored under: the core for a publish, the manager for the rest. */
  program: string;
  index: number;
  event: NearEvent;
  data: Publish | NttReceived | NttSettled;
  topics: string[];
}

/**
 * A transaction's instructions, depth-first in execution order, each with its caller and what it
 * invoked. Inner instructions are placed by their stack height; a transaction too old to carry one
 * hangs them all off their top-level instruction.
 *
 * @param tx The transaction, whole.
 */
export function instructions(tx: Tx): Instruction[] {
  const loaded = tx.meta.loadedAddresses;
  const keys = [
    ...tx.transaction.message.accountKeys,
    ...(loaded?.writable ?? []),
    ...(loaded?.readonly ?? []),
  ];
  const inner = new Map((tx.meta.innerInstructions ?? []).map((i) => [i.index, i.instructions]));
  const resolve = (ix: RawInstruction, caller: string | null, index: number, depth: number) => ({
    program: keys[ix.programIdIndex],
    caller,
    data: base58.decode(ix.data),
    accounts: ix.accounts.map((a) => keys[a]),
    index,
    depth,
    children: [] as Instruction[],
  });

  const out: Instruction[] = [];
  tx.transaction.message.instructions.forEach((ix, i) => {
    const top = resolve(ix, null, i * PER_INSTRUCTION, 1);
    out.push(top);
    const stack: Instruction[] = [top];
    (inner.get(i) ?? []).forEach((jx, j) => {
      const depth = Math.max(2, jx.stackHeight ?? 2);
      while (stack.length >= depth) stack.pop();
      const parent = stack[stack.length - 1];
      const node = resolve(jx, parent.program, i * PER_INSTRUCTION + j + 1, depth);
      parent.children.push(node);
      stack.push(node);
      out.push(node);
    });
  });
  return out;
}

/**
 * The posted VAAs a transaction's deliveries read — accounts the watcher fetches before decoding,
 * since the instruction names the VAA only by its address.
 *
 * @param ixs The transaction's instructions.
 * @param programs NTT programs we own.
 */
export function postedVaas(ixs: Instruction[], programs: ReadonlySet<string>): string[] {
  return ixs
    .filter((ix) => programs.has(ix.program) && tag(ix) === RECEIVE)
    .map((ix) => ix.accounts[3]);
}

/**
 * What a transaction did that we index: the Wormhole messages the core published, and every NTT
 * delivery our programs received, released or held.
 *
 * A publish keeps its emitter as a topic, for the watch entry to filter on; which programs called
 * the core is not this function's business. A delivery is keyed by its digest, and — because a
 * release names no VAA — by the inbox item that digest derives, which is all a release carries.
 *
 * @param tx The transaction, whole.
 * @param ixs Its instructions.
 * @param core The Wormhole core program.
 * @param programs NTT programs we own.
 * @param vaas Posted VAA accounts' data, by address.
 * @param topic Topic0 for an event.
 */
export function decode(
  tx: Tx,
  ixs: Instruction[],
  core: string,
  programs: ReadonlySet<string>,
  vaas: Map<string, Uint8Array>,
  topic: (e: NearEvent) => string,
): Decoded[] {
  const out: Decoded[] = [];
  const sequences = (tx.meta.logMessages ?? [])
    .map((l) => /^Program log: Sequence: (\d+)$/.exec(l)?.[1])
    .filter((s): s is string => s !== undefined);
  let posted = 0;

  for (const ix of ixs) {
    if (ix.program === core && CORE_POSTS.has(ix.data[0])) {
      // Every post logs its sequence, in the order the posts ran.
      const seq = sequences[posted++];
      const p = publish(ix, seq);
      if (p) {
        out.push({
          program: core,
          index: ix.index,
          event: PUBLISH,
          data: p,
          topics: [topic(PUBLISH), `0x${p.emitter}`],
        });
      }
      continue;
    }
    if (!programs.has(ix.program)) continue;

    const t = tag(ix);
    if (t === RECEIVE || t === RECEIVE_DATA) {
      const body = t === RECEIVE ? fromPosted(vaas.get(ix.accounts[3])) : fromData(ix.data);
      const r = body && received(body);
      if (r) {
        out.push({
          program: ix.program,
          index: ix.index,
          event: NTT_RECEIVED,
          data: r,
          topics: [topic(NTT_RECEIVED)],
        });
      }
    } else if (RELEASES.has(t)) {
      // A release that was not yet due returns without paying, and that is the hold.
      const event = pays(ix) ? NTT_RELEASED : NTT_QUEUED;
      out.push({
        program: ix.program,
        index: ix.index,
        event,
        data: { inboxItem: ix.accounts[2] },
        topics: [topic(event)],
      });
    }
  }
  return out;
}

/** An instruction's Anchor discriminator, hex. */
const tag = (ix: Instruction) => Buffer.from(ix.data.subarray(0, 8)).toString("hex");

/**
 * A core post: `[tag u8][nonce u32][payload: u32 length, bytes][consistency u8]`, with the emitter
 * its third account.
 *
 * @param ix The post.
 * @param seq The sequence the core logged for it.
 */
function publish(ix: Instruction, seq: string | undefined): Publish | null {
  if (seq === undefined || ix.data.length < 10) return null;
  const b = Buffer.from(ix.data);
  const len = b.readUInt32LE(5);
  if (b.length < 10 + len) return null;
  return {
    data: b.subarray(9, 9 + len).toString("hex"),
    nonce: b.readUInt32LE(1),
    emitter: Buffer.from(base58.decode(ix.accounts[2])).toString("hex"),
    seq,
    consistency: b[9 + len],
  };
}

/** What a VAA says, as far as a delivery needs it. */
interface Body {
  chain: number;
  emitter: string;
  sequence: bigint;
  payload: Buffer;
}

/**
 * The core's `PostedVAAV1` account: `"vaa"`, version, consistency, time, signature set, submission
 * time, nonce, then sequence (u64), emitter chain (u16), emitter (32) and the payload — all little
 * endian, Borsh.
 *
 * @param d The account's data.
 */
function fromPosted(d: Uint8Array | undefined): Body | null {
  if (!d || d.length < 95) return null;
  const b = Buffer.from(d);
  if (b.subarray(0, 3).toString() !== "vaa") return null;
  const len = b.readUInt32LE(91);
  return {
    sequence: b.readBigUInt64LE(49),
    chain: b.readUInt16LE(57),
    emitter: b.subarray(59, 91).toString("hex"),
    payload: b.subarray(95, 95 + len),
  };
}

/**
 * A VAA body passed as instruction data, after the discriminator and the guardian set's bump: the
 * body as a Borsh `Vec<u8>`, its fields big endian as the guardians sign them.
 *
 * @param data The instruction's data.
 */
function fromData(data: Uint8Array): Body | null {
  const b = Buffer.from(data);
  if (b.length < 13) return null;
  const span = b.subarray(13, 13 + b.readUInt32LE(9));
  if (span.length < 51) return null;
  return {
    chain: span.readUInt16BE(8),
    emitter: span.subarray(10, 42).toString("hex"),
    sequence: span.readBigUInt64BE(42),
    payload: span.subarray(51),
  };
}

/**
 * A delivery's identity: the digest NTT settles on, the VAA it came in, and the inbox item its
 * release will name — `PDA(["inbox_item", digest], recipient manager)`.
 *
 * @param v The VAA.
 */
function received(v: Body): NttReceived | null {
  const t = parseNttTransfer(`0x${v.payload.toString("hex")}`, v.chain);
  if (!t) return null;
  const manager = v.payload.subarray(36, 68);
  const digest = Buffer.from(t.digest.slice(2), "hex");
  return {
    digest: t.digest,
    vaaId: vaaId(v.chain, v.emitter, v.sequence),
    inboxItem: base58.encode(pda([Buffer.from("inbox_item"), digest], manager)),
  };
}

/**
 * Whether an instruction paid anything out: a token transfer or mint anywhere beneath it.
 *
 * @param ix The release.
 */
function pays(ix: Instruction): boolean {
  return ix.children.some(
    (c) => (TOKEN_PROGRAMS.has(c.program) && TOKEN_PAYOUTS.has(c.data[0])) || pays(c),
  );
}

/**
 * A program-derived address: the first bump, from 255 down, whose hash is off the ed25519 curve.
 *
 * @param seeds The seeds.
 * @param program The deriving program.
 */
export function pda(seeds: Uint8Array[], program: Uint8Array): Uint8Array {
  const marker = new TextEncoder().encode("ProgramDerivedAddress");
  for (let bump = 255; bump >= 0; bump--) {
    const h = sha256(Buffer.concat([...seeds, Uint8Array.of(bump), program, marker]));
    if (!onCurve(h)) return h;
  }
  throw new Error("no viable bump");
}

/** Whether 32 bytes decode to an ed25519 point. */
function onCurve(b: Uint8Array): boolean {
  try {
    ed25519.Point.fromHex(b);
    return true;
  } catch {
    return false;
  }
}
