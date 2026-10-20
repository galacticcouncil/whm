import {
  actions,
  baseEncode,
  buildDelegateAction,
  encodeSignedDelegate,
  KeyType,
  PublicKey,
  Signature,
  type SignedDelegate,
} from "near-api-js";

/**
 * Decode the contract's borsh `SignedDelegateAction` — one function call — into near-api-js's own
 * `SignedDelegate`, and refuse unless it re-encodes to the same bytes.
 *
 * @param bytes The `signed_delegate` the contract emitted.
 * @returns The delegate, ready to relay.
 * @throws When the bytes are not one ed25519-signed function call, or do not round-trip.
 */
export function decodeSignedDelegate(bytes: Buffer): SignedDelegate {
  let at = 0;
  const raw = (n: number) => bytes.subarray(at, (at += n));
  const u32 = () => raw(4).readUInt32LE(0);
  const u64 = () => raw(8).readBigUInt64LE(0);
  const u128 = () => {
    const b = raw(16);
    return (b.readBigUInt64LE(8) << 64n) | b.readBigUInt64LE(0);
  };
  const str = () => raw(u32()).toString("utf8");

  const senderId = str();
  const receiverId = str();
  if (u32() !== 1) throw new Error("expected one action");
  if (raw(1)[0] !== 2) throw new Error("expected a FunctionCall");
  const methodName = str();
  const callArgs = Uint8Array.from(raw(u32()));
  const gas = u64();
  const deposit = u128();
  const nonce = u64();
  const maxBlockHeight = u64();
  if (raw(1)[0] !== 0) throw new Error("expected an ED25519 key");
  const publicKey = PublicKey.fromString(`ed25519:${baseEncode(raw(32))}`);
  if (raw(1)[0] !== 0) throw new Error("expected an ED25519 signature");
  const signature = Uint8Array.from(raw(64));
  if (at !== bytes.length) throw new Error("trailing bytes");

  const delegate: SignedDelegate = {
    delegateAction: buildDelegateAction({
      actions: [actions.functionCall(methodName, callArgs, gas, deposit)],
      maxBlockHeight,
      nonce,
      publicKey,
      receiverId,
      senderId,
    }),
    // `SignedDelegate` is a type only at runtime; the encoders take the plain shape.
    signature: new Signature({ keyType: KeyType.ED25519, data: signature }),
  };
  if (!Buffer.from(encodeSignedDelegate(delegate)).equals(bytes)) {
    throw new Error("decoded delegate does not re-encode to the emitted bytes");
  }
  return delegate;
}
