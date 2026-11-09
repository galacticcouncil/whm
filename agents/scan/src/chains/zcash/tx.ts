import { addressOf, hash160 } from "./address";
import { T1, T3 } from "./consts";

export interface TxInput {
  /** The spent output, `txid:vout`. */
  prevout: string;
  /** Who signed for it, where the script says: a t1 for a key, a t3 for a standard script. */
  address: string | null;
}

export interface TxOutput {
  /** Zatoshi. */
  value: bigint;
  address: string | null;
}

export interface ZcashTx {
  version: number;
  inputs: TxInput[];
  outputs: TxOutput[];
}

/**
 * The transparent part of a raw Zcash transaction — enough to say who paid whom.
 *
 * v4 (Sapling) carries the transparent bundle straight after the version group; v5 and later put
 * the consensus branch, lock time and expiry first. Shielded parts follow and are not read: a
 * shielded sender has no address to show.
 *
 * @param raw The serialized transaction.
 * @returns The transaction, or null when it does not parse as one.
 */
export function parseTx(raw: Buffer): ZcashTx | null {
  try {
    const r = new Reader(raw);
    const version = r.u32() & 0x7fffffff;
    if (version < 4) return null;
    r.skip(4); // version group
    if (version >= 5) r.skip(12); // consensus branch, lock time, expiry

    const inputs: TxInput[] = [];
    for (let i = r.compact(); i > 0; i--) {
      const txid = Buffer.from(r.bytes(32)).reverse().toString("hex");
      const vout = r.u32();
      const script = r.bytes(r.compact());
      r.skip(4); // sequence
      inputs.push({ prevout: `${txid}:${vout}`, address: signer(script) });
    }

    const outputs: TxOutput[] = [];
    for (let i = r.compact(); i > 0; i--) {
      const value = r.u64();
      outputs.push({ value, address: payee(r.bytes(r.compact())) });
    }
    return { version, inputs, outputs };
  } catch {
    return null;
  }
}

/**
 * Who a scriptSig signs as. Its last push is a public key for P2PKH, or the redeem script for P2SH.
 *
 * @param script The scriptSig.
 */
function signer(script: Buffer): string | null {
  const last = pushes(script).at(-1);
  if (!last) return null;
  const isKey =
    (last.length === 33 && (last[0] === 2 || last[0] === 3)) ||
    (last.length === 65 && last[0] === 4);
  return addressOf(isKey ? T1 : T3, hash160(last));
}

/**
 * Who an output pays, for the two standard transparent shapes.
 *
 * @param script The scriptPubKey.
 */
function payee(script: Buffer): string | null {
  // OP_DUP OP_HASH160 <20> … OP_EQUALVERIFY OP_CHECKSIG
  if (script.length === 25 && script[0] === 0x76 && script[1] === 0xa9 && script[2] === 0x14) {
    return addressOf(T1, script.subarray(3, 23));
  }
  // OP_HASH160 <20> … OP_EQUAL
  if (script.length === 23 && script[0] === 0xa9 && script[1] === 0x14) {
    return addressOf(T3, script.subarray(2, 22));
  }
  return null;
}

/** The data pushes of a script, in order. */
function pushes(script: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let i = 0;
  while (i < script.length) {
    const op = script[i++];
    let len: number;
    if (op >= 1 && op <= 75) len = op;
    else if (op === 0x4c) len = script[i++];
    else if (op === 0x4d) ((len = script.readUInt16LE(i)), (i += 2));
    else if (op === 0x4e) ((len = script.readUInt32LE(i)), (i += 4));
    else continue;
    out.push(script.subarray(i, i + len));
    i += len;
  }
  return out;
}

/** A little-endian cursor over a buffer. Reading past the end throws. */
class Reader {
  private at = 0;
  constructor(private readonly b: Buffer) {}

  bytes(n: number): Buffer {
    if (this.at + n > this.b.length) throw new RangeError("short transaction");
    const out = this.b.subarray(this.at, this.at + n);
    this.at += n;
    return out;
  }
  skip(n: number): void {
    this.bytes(n);
  }
  u32(): number {
    return this.bytes(4).readUInt32LE(0);
  }
  u64(): bigint {
    return this.bytes(8).readBigUInt64LE(0);
  }
  compact(): number {
    const v = this.bytes(1)[0];
    if (v < 0xfd) return v;
    if (v === 0xfd) return this.bytes(2).readUInt16LE(0);
    if (v === 0xfe) return this.u32();
    return Number(this.u64());
  }
}
