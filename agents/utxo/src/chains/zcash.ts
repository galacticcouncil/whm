import { decodeBase58Check, encodeBase58Check } from "./base58";
import type { UtxoChain } from "./types";

/** Mainnet transparent versions: t1 (P2PKH), t3 (P2SH). */
const VERSIONS = ["1cb8", "1cbd"];

/**
 * Zcash, transparent addresses only — checked as `ZecUtxoEmitter.send` and the contract check them:
 * base58check, 22 bytes, a mainnet transparent version. The emitter takes the decoded `bytes22`.
 */
export const zcash: UtxoChain = {
  name: "zcash",
  contract: "withdraw-zec.hydration-whm.near",
  // Pinned by the contract's unit tests and the mainnet canary.
  golden: {
    address: "t1KfwsnwJeNRVjQGBDZhwKskpQbih2qx5Ua",
    account: "da66533e90179ebb2e9e546afd4410e36f76e8a8b4ec0376b4e2a8825f802e11",
  },
  deposit: {
    connector: "zcash-connector.bridge.near",
    manager: "ntt-zec.hydration-whm.near",
    omniChain: "zcash",
  },

  encode(address) {
    const body = decodeBase58Check(address);
    if (!body || body.length !== 22 || !VERSIONS.includes(body.subarray(0, 2).toString("hex"))) {
      return null;
    }
    return `0x${body.toString("hex")}`;
  },

  decode(bytes) {
    const body = Buffer.from(bytes.slice(2), "hex");
    if (body.length !== 22 || !VERSIONS.includes(body.subarray(0, 2).toString("hex"))) {
      throw new Error(`not a transparent address: ${bytes}`);
    }
    return encodeBase58Check(body);
  },

  // ZIP-317: one input, two outputs is always 2 × 5,000 zat.
  minerFee: () => 10_000n,
};
