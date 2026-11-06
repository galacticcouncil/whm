// MUST come first, for the reason in src/boot.ts.
import { restoreNativeFetch } from "../src/fetch";

import { readFileSync } from "node:fs";
import { parseAbi } from "viem";

import { registerHydration } from "../src/chains";
import { baseClients } from "../src/clients/base";
import { privateKeyBase, req } from "../src/config";
import { settlementAmount } from "../src/engine/ntt";
import { createQueue } from "../src/engine/queue";
import logger from "../src/logger";
import type { ParsedVaa } from "../src/types";

import { deliverOutbound, managerDigest, outboundAbi, vaaHash } from "../src/apps/ntt/outbound";
import { BASE_ROUTES } from "../src/apps/ntt/routes";

/**
 * Fork check for `ntt-base`: run the delivery path twice over one real Hydration -> Base EURC VAA
 * on an anvil fork of Base taken before that VAA was delivered, and assert that the first pass
 * delivers (the recipient is paid the transfer's amount, both replay guards flip) and the second
 * skips on the read, sending nothing.
 *
 *   anvil --fork-url <base rpc> --fork-block-number <block before the delivery> --port 8546
 *   RPC_BASE=http://127.0.0.1:8546 PRIVKEY_BASE=<an anvil account key> \
 *     npx tsx agents/relayer/scripts/verify-ntt-base.ts <file holding the VAA as hex>
 *
 * Never point it at a live RPC: it signs and sends.
 */

const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);
const managerAbi = parseAbi(["function token() view returns (address)"]);

/** Wormhole VAA body: timestamp 4 · nonce 4 · emitterChain 2 · emitter 32 · sequence 8 · consistency 1. */
function parseVaa(bytes: Buffer): ParsedVaa {
  const body = 6 + bytes.readUInt8(5) * 66;
  return {
    bytes,
    timestamp: bytes.readUInt32BE(body),
    emitterChain: bytes.readUInt16BE(body + 8),
    emitterAddress: bytes.subarray(body + 10, body + 42),
    sequence: bytes.readBigUInt64BE(body + 42),
    payload: bytes.subarray(body + 51),
  };
}

function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(`FAIL: ${what}`);
  logger.info(`ok: ${what}`);
}

async function main(): Promise<void> {
  restoreNativeFetch();
  registerHydration();
  const rpc = req("RPC_BASE");
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(rpc)) {
    throw new Error(`RPC_BASE must be a local fork, got ${rpc}`);
  }

  const raw = readFileSync(process.argv[2], "utf8").trim().replace(/^0x/, "");
  const vaa = parseVaa(Buffer.from(raw, "hex"));
  const route = BASE_ROUTES.find(
    (r) => vaa.emitterAddress.toString("hex") === r.sourceEmitter.slice(2).toLowerCase().padStart(64, "0"),
  );
  if (!route) throw new Error("VAA is not from a BASE_ROUTES emitter");
  check(vaa.emitterChain === 73, `VAA from Hydration, sequence ${vaa.sequence}`);

  const clients = await baseClients(rpc, privateKeyBase());
  const { publicClient } = clients;
  const queue = createQueue({ publicClient, account: clients.account, warnMultiplier: 50n });
  await queue.init();

  const token = await publicClient.readContract({ address: route.manager, abi: managerAbi, functionName: "token" });
  const decimals = await publicClient.readContract({ address: token, abi: erc20Abi, functionName: "decimals" });
  // TransceiverMessage 136 · NTT prefix 4 · decimals 1 · amount 8 · sourceToken 32, then `to`.
  const recipient = `0x${vaa.payload.subarray(181 + 12, 213).toString("hex")}` as const;
  const amount = settlementAmount(vaa.payload, decimals);

  const guards = async () =>
    Promise.all([
      publicClient.readContract({
        address: route.transceiver,
        abi: outboundAbi,
        functionName: "isVAAConsumed",
        args: [vaaHash(vaa.bytes)],
      }),
      publicClient.readContract({
        address: route.manager,
        abi: outboundAbi,
        functionName: "isMessageExecuted",
        args: [managerDigest(vaa.emitterChain, vaa.payload)],
      }),
    ]);
  const balance = () =>
    publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [recipient] });

  const [consumed0, executed0] = await guards();
  check(!consumed0 && !executed0, "before: VAA not consumed, message not executed (fork is before the delivery)");
  const before = await balance();
  const nonce0 = await publicClient.getTransactionCount({ address: clients.account.address });

  const first = await deliverOutbound(route, vaa, clients, queue, logger);
  check(first === "delivered", `pass 1 outcome is "delivered" (got "${first}")`);
  const paid = (await balance()) - before;
  check(paid === amount, `pass 1 paid the recipient ${amount} EURC base units (got ${paid})`);
  const [consumed1, executed1] = await guards();
  check(consumed1 && executed1, "after pass 1: isVAAConsumed(vaa hash) and isMessageExecuted(digest) both true");
  const nonce1 = await publicClient.getTransactionCount({ address: clients.account.address });
  check(nonce1 === nonce0 + 1, "pass 1 sent exactly one transaction");

  const second = await deliverOutbound(route, vaa, clients, queue, logger);
  check(second === "already-delivered", `pass 2 outcome is "already-delivered" (got "${second}")`);
  const nonce2 = await publicClient.getTransactionCount({ address: clients.account.address });
  check(nonce2 === nonce1, "pass 2 sent nothing");
  check((await balance()) - before === amount, "recipient paid once");

  logger.info("PASS");
  process.exit(0);
}

main().catch((e) => {
  logger.error((e as Error).message);
  process.exit(1);
});
