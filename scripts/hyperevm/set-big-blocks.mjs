import { concat, keccak256, parseSignature, toHex, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { fileURLToPath } from "node:url";

const api = process.env.HYPERLIQUID_API || "https://api.hyperliquid.xyz";
const rpc = process.env.RPC_HYPEREVM || "https://rpc.hyperliquid.xyz/evm";

/**
 * msgpack of `{ type: "evmUserModify", usingBigBlocks }`, key order preserved.
 * Hand-encoded: a fixmap of two fixstr keys, a fixstr value and a bool.
 *
 * @param {boolean} enable - big blocks on or off
 * @returns {Uint8Array} the packed action bytes
 */
export function packAction(enable) {
  const str = (s) => [0xa0 | s.length, ...new TextEncoder().encode(s)];
  return new Uint8Array([
    0x82,
    ...str("type"),
    ...str("evmUserModify"),
    ...str("usingBigBlocks"),
    enable ? 0xc3 : 0xc2,
  ]);
}

/**
 * L1 action connection id: keccak256(msgpack(action) || nonce u64 BE || 0x00 no vault).
 *
 * @param {boolean} enable - big blocks on or off
 * @param {number} nonce - action nonce (ms timestamp)
 * @returns {`0x${string}`} the connection id signed in the `Agent` struct
 */
export function connectionId(enable, nonce) {
  return keccak256(concat([toHex(packAction(enable)), toHex(BigInt(nonce), { size: 8 }), "0x00"]));
}

/**
 * Read the per-address big-blocks flag from HyperEVM.
 *
 * @param {string} address - EVM address to check
 * @returns {Promise<boolean>} whether the address deploys into big blocks
 */
async function usingBigBlocks(address) {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_usingBigBlocks", params: [address] }),
  });
  const json = await res.json();
  if (typeof json.result !== "boolean") throw new Error(`eth_usingBigBlocks: ${JSON.stringify(json)}`);
  return json.result;
}

async function main() {
  const mode = process.argv[2];
  if (mode !== "on" && mode !== "off") throw new Error("Usage: set-big-blocks.mjs <on|off>");
  const enable = mode === "on";

  const pk = process.env.PK_HYPEREVM;
  if (!pk) throw new Error("Missing PK_HYPEREVM.");
  const account = privateKeyToAccount(pk);

  const before = await usingBigBlocks(account.address);
  console.log(`${account.address} usingBigBlocks=${before}`);
  if (before === enable) {
    console.log("Already set, nothing to do.");
    return;
  }

  const nonce = Date.now();
  const signature = await account.signTypedData({
    domain: { name: "Exchange", version: "1", chainId: 1337, verifyingContract: zeroAddress },
    types: {
      Agent: [
        { name: "source", type: "string" },
        { name: "connectionId", type: "bytes32" },
      ],
    },
    primaryType: "Agent",
    message: { source: "a", connectionId: connectionId(enable, nonce) },
  });
  const { r, s, yParity } = parseSignature(signature);

  // vaultAddress omitted entirely: the API rejects an explicit null
  const res = await fetch(`${api}/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: { type: "evmUserModify", usingBigBlocks: enable },
      nonce,
      signature: { r, s, v: 27 + yParity },
    }),
  });
  const body = await res.text();
  let json = {};
  try {
    json = JSON.parse(body);
  } catch {}
  if (!res.ok || json.status !== "ok") throw new Error(`exchange ${res.status}: ${body}`);
  console.log(`exchange: ${body}`);

  for (let i = 0; i < 10; i++) {
    if ((await usingBigBlocks(account.address)) === enable) {
      console.log(`${account.address} usingBigBlocks=${enable} ✓`);
      return;
    }
    await new Promise((done) => setTimeout(done, 3000));
  }
  throw new Error(`Flag still ${!enable} after 30s, check eth_usingBigBlocks manually.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
