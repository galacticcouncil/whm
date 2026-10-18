import { keccak256 } from "viem";

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

import { EVENTS_AT } from "./consts";
import type { Input, Tx } from "./types";

/** A decoded event, before the watcher makes it a row. */
export interface Decoded {
  /** What it is stored under: the core's package for a publish, the manager's state for the rest. */
  address: string;
  index: number;
  event: NearEvent;
  data: Publish | NttReceived | NttSettled;
  topics: string[];
}

const NTT_PREFIX = "994e5454";

/**
 * What a transaction did that we index.
 *
 * Outbound, the Wormhole core emits `WormholeMessage` — the one event anything here emits — and it
 * is stored as a publish, its emitter a topic for the watch entry to filter on. Inbound, NTT emits
 * nothing, so the delivery is read off the transaction itself: a VAA verified by `parse_and_verify`
 * is one of its inputs, `ntt::redeem` attests it, and `ntt::release` — which aborts the whole
 * transaction when it is not yet due — pays it out. A redeem without a release is a hold. A release
 * on its own, later, rebuilds the manager message from its inputs instead of a VAA.
 *
 * @param tx The transaction.
 * @param states NTT manager states we own.
 * @param topic Topic0 for an event.
 */
export function decode(
  tx: Tx,
  states: ReadonlySet<string>,
  topic: (e: NearEvent) => string,
): Decoded[] {
  const out: Decoded[] = [];

  tx.effects.events.nodes.forEach(({ contents }, i) => {
    const [pkg, module, name] = contents.type.repr.split("::");
    if (module !== "publish_message" || name !== "WormholeMessage") return;
    const j = contents.json as {
      sender: string;
      sequence: string;
      nonce: number;
      payload: string;
      consistency_level: number;
    };
    const data: Publish = {
      data: Buffer.from(j.payload, "base64").toString("hex"),
      nonce: j.nonce,
      emitter: j.sender.replace(/^0x/, "").padStart(64, "0"),
      seq: String(j.sequence),
      consistency: j.consistency_level,
    };
    out.push({
      address: pkg,
      index: EVENTS_AT + i,
      event: PUBLISH,
      data,
      topics: [topic(PUBLISH), `0x${data.emitter}`],
    });
  });

  const inputs = tx.kind.inputs?.nodes ?? [];
  const state = inputs.find(
    (n): n is { __typename: "SharedInput"; address: string } =>
      n.__typename === "SharedInput" && states.has((n as { address: string }).address),
  )?.address;
  if (!state) return out;

  const calls = new Set(
    (tx.kind.commands?.nodes ?? []).flatMap((c) =>
      c.function ? [`${c.function.module.name}::${c.function.name}`] : [],
    ),
  );
  const redeem = calls.has("ntt::redeem");
  const release = calls.has("ntt::release");
  if (!redeem && !release) return out;

  const vaa =
    values(inputs)
      .map(vaaBody)
      .find((v) => v !== null) ?? null;
  const t = vaa && parseNttTransfer(`0x${vaa.payload.toString("hex")}`, vaa.chain);
  const digest = t?.digest ?? (release ? rebuilt(inputs) : null);
  if (!digest) return out;

  if (redeem && vaa) {
    const data: NttReceived = { digest, vaaId: vaaId(vaa.chain, vaa.emitter, vaa.sequence) };
    out.push({
      address: state,
      index: 0,
      event: NTT_RECEIVED,
      data,
      topics: [topic(NTT_RECEIVED)],
    });
  }
  const event = release ? NTT_RELEASED : NTT_QUEUED;
  out.push({ address: state, index: 1, event, data: { digest }, topics: [topic(event)] });
  return out;
}

/**
 * The inputs' plain values, BCS-decoded where they are byte vectors — a `vector<u8>` is a ULEB128
 * length and the bytes.
 *
 * @param inputs The transaction's inputs.
 */
function values(inputs: Input[]): Buffer[] {
  return inputs.flatMap((n) => {
    if (n.__typename !== "MoveValue") return [];
    const v = n as { type: { repr: string }; bcs: string };
    if (v.type.repr !== "vector<u8>") return [];
    const b = Buffer.from(v.bcs, "base64");
    let len = 0;
    let shift = 0;
    let at = 0;
    for (; at < b.length; at++) {
      len |= (b[at] & 0x7f) << shift;
      shift += 7;
      if (!(b[at] & 0x80)) break;
    }
    return [b.subarray(at + 1, at + 1 + len)];
  });
}

/**
 * A signed VAA's body: version 1, the guardian set, the signatures, then the body big endian.
 *
 * @param b Candidate bytes.
 */
function vaaBody(b: Buffer) {
  if (b.length < 6 || b[0] !== 1) return null;
  const body = b.subarray(6 + 66 * b[5]);
  if (body.length < 51) return null;
  return {
    chain: body.readUInt16BE(8),
    emitter: body.subarray(10, 42).toString("hex"),
    sequence: body.readBigUInt64BE(42),
    payload: body.subarray(51),
  };
}

/**
 * A release's digest without a VAA: the manager message it rebuilds from its inputs — the source
 * chain (`u16`), the id (32 bytes), the sender (`address`) and the transfer payload — hashed as NTT
 * hashes it, `keccak256(chain ++ id ++ sender ++ u16 length ++ payload)`.
 *
 * @param inputs The transaction's inputs.
 */
function rebuilt(inputs: Input[]): `0x${string}` | null {
  const typed = (repr: string) =>
    inputs.find(
      (n) => n.__typename === "MoveValue" && (n as { type: { repr: string } }).type.repr === repr,
    ) as { bcs: string } | undefined;
  const chain = typed("u16");
  const sender = typed("address");
  const bytes = values(inputs);
  const id = bytes.find((b) => b.length === 32);
  const payload = bytes.find((b) => b.subarray(0, 4).toString("hex") === NTT_PREFIX);
  if (!chain || !sender || !id || !payload) return null;
  const len = Buffer.alloc(2);
  len.writeUInt16BE(payload.length);
  const from = Buffer.alloc(2);
  from.writeUInt16BE(Buffer.from(chain.bcs, "base64").readUInt16LE(0));
  return keccak256(
    new Uint8Array(Buffer.concat([from, id, Buffer.from(sender.bcs, "base64"), len, payload])),
  );
}
