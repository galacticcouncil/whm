// MUST come first, for the reason in src/boot.ts.
import { restoreNativeFetch } from "../src/fetch";

import { readFileSync } from "node:fs";
import { encodeFunctionData, formatUnits, parseAbi, type Address, type Hex } from "viem";

import { registerHydration } from "../src/chains";
import { baseClients } from "../src/clients/base";
import type { ChainClients } from "../src/clients/hydration";
import { privateKeyBase, req } from "../src/config";
import { settlementAmount } from "../src/engine/ntt";
import { createQueue } from "../src/engine/queue";
import logger from "../src/logger";
import type { ParsedVaa } from "../src/types";

import { deliverOutbound, managerDigest, outboundAbi, runOutbound, vaaHash, type Outcome } from "../src/apps/ntt/outbound";
import { BASE_ROUTES } from "../src/apps/ntt/routes";

/**
 * Fork check for `ntt-base`. Drives the delivery path over one real Hydration -> Base EURC VAA on an
 * anvil fork of Base taken before that VAA was delivered, one case per snapshot:
 *
 *   young           a VAA younger than the grace period: nothing read or sent
 *   deliver-skip    pass 1 delivers (recipient paid the transfer's amount, both guards flip),
 *                   pass 2 reads it as delivered and sends nothing
 *   precheck-race   someone else delivers between our reads and our simulate: nothing sent
 *   sameblock-race  someone else's delivery is ordered before ours in the same block: ours reverts
 *                   and is reported as lost, not delivered; recipient paid once
 *   queued          the manager's inbound limit is lowered (owner impersonated) so the transfer is
 *                   queued: reported `queued` with an alert, recipient not paid, never "delivered"
 *   precheck-queued the limit is lowered and someone else's delivery, queued, lands between our
 *                   reads and our simulate: `queued` with an alert, nothing sent
 *   forged          the right emitter, one amount byte flipped: every run throws for a retry and
 *                   sends nothing; only the last run of a 3-run budget alerts
 *
 *   anvil --fork-url <base rpc> --fork-block-number <block before the delivery> --chain-id 8453 --port <port>
 *   RPC_BASE=http://127.0.0.1:<port> PRIVKEY_BASE=<an anvil account key> \
 *     npx tsx agents/relayer/scripts/verify-ntt-base.ts <file holding the VAA as hex>
 *
 * Never point it at a live RPC: it signs, sends and impersonates. It refuses any non-local URL.
 */

const GRACE = 15 * 60;
const OTHER = "0x00000000000000000000000000000000000E8EC0"; // stands in for the user or the Executor

const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);
const managerAbi = parseAbi([
  "function token() view returns (address)",
  "function owner() view returns (address)",
  "function setInboundLimit(uint256 limit, uint16 chainId)",
]);

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

let failures = 0;
function check(ok: boolean, what: string): void {
  if (ok) logger.info(`ok: ${what}`);
  else {
    failures++;
    logger.error(`FAIL: ${what}`);
  }
}

let rpcUrl = "";
async function rpc(method: string, params: unknown[] = []): Promise<any> {
  const r = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = (await r.json()) as any;
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

/** Send `data` to `to` from an impersonated `from`, optionally with a higher tip than ours. */
async function sendAs(from: Address, to: Address, data: Hex, tipGwei = 0n): Promise<Hex> {
  await rpc("anvil_impersonateAccount", [from]);
  await rpc("anvil_setBalance", [from, "0x56BC75E2D63100000"]);
  const tx: Record<string, string> = { from, to, data, gas: "0x7A120" };
  if (tipGwei) {
    tx.maxPriorityFeePerGas = `0x${(tipGwei * 10n ** 9n).toString(16)}`;
    tx.maxFeePerGas = `0x${(tipGwei * 2n * 10n ** 9n).toString(16)}`;
  }
  return rpc("eth_sendTransaction", [tx]);
}

async function main(): Promise<void> {
  restoreNativeFetch();
  registerHydration();
  rpcUrl = req("RPC_BASE");
  if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(rpcUrl)) {
    throw new Error(`RPC_BASE must be a local fork, got ${rpcUrl}`);
  }

  const raw = readFileSync(process.argv[2], "utf8").trim().replace(/^0x/, "");
  const real = parseVaa(Buffer.from(raw, "hex"));
  const route = BASE_ROUTES.find(
    (r) => real.emitterAddress.toString("hex") === r.sourceEmitter.slice(2).toLowerCase().padStart(64, "0"),
  );
  if (!route) throw new Error("VAA is not from a BASE_ROUTES emitter");
  check(real.emitterChain === 73, `VAA from Hydration, sequence ${real.sequence}`);

  const clients: ChainClients = await baseClients(rpcUrl, privateKeyBase());
  const { publicClient, account } = clients;
  // A fresh queue per case: a revert rewinds the account's nonce, which a queue keeps in memory.
  let queue = createQueue({ publicClient, account, warnMultiplier: 50n });

  const token = await publicClient.readContract({ address: route.manager, abi: managerAbi, functionName: "token" });
  const decimals = await publicClient.readContract({ address: token, abi: erc20Abi, functionName: "decimals" });
  // TransceiverMessage 136 · NTT prefix 4 · decimals 1 · amount 8 · sourceToken 32, then `to`.
  const recipient = `0x${real.payload.subarray(181 + 12, 213).toString("hex")}` as Address;
  const amount = settlementAmount(real.payload, decimals);
  const deliverData = encodeFunctionData({
    abi: outboundAbi,
    functionName: "receiveMessage",
    args: [`0x${real.bytes.toString("hex")}`],
  });

  const guards = () =>
    Promise.all([
      publicClient.readContract({
        address: route.transceiver,
        abi: outboundAbi,
        functionName: "isVAAConsumed",
        args: [vaaHash(real.bytes)],
      }),
      publicClient.readContract({
        address: route.manager,
        abi: outboundAbi,
        functionName: "isMessageExecuted",
        args: [managerDigest(real.emitterChain, real.payload)],
      }),
    ]);
  const balance = () =>
    publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [recipient] });
  const nonce = () => publicClient.getTransactionCount({ address: account.address });

  const alerts: string[] = [];
  const deliverOpts = (now?: number) => ({
    graceSeconds: GRACE,
    now: now === undefined ? undefined : () => now,
    alert: async (m: string) => void alerts.push(m),
  });
  const pass = async (vaa: ParsedVaa, now?: number): Promise<Outcome | string> => {
    try {
      return await deliverOutbound(route, vaa, clients, queue, logger, deliverOpts(now));
    } catch (e) {
      return `THROW ${(e as Error).message.split("\n")[0]}`;
    }
  };

  const pc = publicClient as any;
  const wallet = clients.wallet as any;
  const original = {
    simulate: pc.simulateContract.bind(pc),
    wait: pc.waitForTransactionReceipt.bind(pc),
    write: wallet.writeContract.bind(wallet),
  };

  // A revert consumes its snapshot, so each case takes a fresh one after reverting.
  let snapshot = await rpc("evm_snapshot");
  async function scenario(name: string, body: () => Promise<void>): Promise<void> {
    logger.info(`--- ${name}`);
    alerts.length = 0;
    queue = createQueue({ publicClient, account, warnMultiplier: 50n });
    await queue.init();
    const [c, x] = await guards();
    check(!c && !x, `${name}: starts undelivered (fork is before the delivery)`);
    try {
      await body();
    } finally {
      pc.simulateContract = original.simulate;
      pc.waitForTransactionReceipt = original.wait;
      wallet.writeContract = original.write;
      await rpc("evm_setAutomine", [true]);
      await rpc("evm_revert", [snapshot]);
      snapshot = await rpc("evm_snapshot");
    }
  }

  // Owner impersonated on the fork only: the inbound limit from Hydration drops to 1 token.
  const setOneTokenLimit = async () => {
    const owner = await publicClient.readContract({ address: route.manager, abi: managerAbi, functionName: "owner" });
    const oneToken = 10n ** BigInt(decimals);
    const setLimit = encodeFunctionData({ abi: managerAbi, functionName: "setInboundLimit", args: [oneToken, 73] });
    await sendAs(owner, route.manager, setLimit);
  };

  await scenario("young", async () => {
    const n0 = await nonce();
    const outcome = await pass(real, real.timestamp + 60);
    check(outcome === "not-yet-due", `young: outcome "not-yet-due" (got "${outcome}")`);
    check((await nonce()) === n0, "young: nothing sent");
    const [c, x] = await guards();
    check(!c && !x, "young: still undelivered");
  });

  await scenario("deliver-skip", async () => {
    const b0 = await balance();
    const n0 = await nonce();
    const first = await pass(real);
    check(first === "delivered", `deliver-skip: pass 1 "delivered" (got "${first}")`);
    check((await balance()) - b0 === amount, `deliver-skip: recipient paid ${amount} base units`);
    const [c, x] = await guards();
    check(c && x, "deliver-skip: isVAAConsumed and isMessageExecuted both true after pass 1");
    check((await nonce()) === n0 + 1, "deliver-skip: pass 1 sent exactly one transaction");
    const second = await pass(real);
    check(second === "already-delivered", `deliver-skip: pass 2 "already-delivered" (got "${second}")`);
    check((await nonce()) === n0 + 1, "deliver-skip: pass 2 sent nothing");
    check((await balance()) - b0 === amount, "deliver-skip: recipient paid once");
  });

  await scenario("precheck-race", async () => {
    const b0 = await balance();
    const n0 = await nonce();
    pc.simulateContract = async (args: unknown) => {
      await sendAs(OTHER, route.transceiver, deliverData);
      return original.simulate(args);
    };
    const outcome = await pass(real);
    check(outcome === "completed-elsewhere", `precheck-race: "completed-elsewhere" (got "${outcome}")`);
    check((await nonce()) === n0, "precheck-race: nothing sent");
    check((await balance()) - b0 === amount, "precheck-race: recipient paid once");
  });

  await scenario("sameblock-race", async () => {
    const b0 = await balance();
    const n0 = await nonce();
    // Our simulate runs on latest; the other delivery (higher tip) is ordered first in our block.
    wallet.writeContract = async (args: unknown) => {
      await rpc("evm_setAutomine", [false]);
      const ours = await original.write(args);
      await sendAs(OTHER, route.transceiver, deliverData, 50n);
      wallet.writeContract = original.write;
      return ours;
    };
    pc.waitForTransactionReceipt = async (args: unknown) => {
      await rpc("evm_mine");
      await rpc("evm_setAutomine", [true]);
      return original.wait(args);
    };
    const outcome = await pass(real);
    check(outcome === "completed-elsewhere", `sameblock-race: lost race, "completed-elsewhere" (got "${outcome}")`);
    check((await nonce()) === n0 + 1, "sameblock-race: our one transaction was sent (and reverted)");
    check((await balance()) - b0 === amount, "sameblock-race: recipient paid once");
  });

  await scenario("queued", async () => {
    await setOneTokenLimit();
    const b0 = await balance();
    const n0 = await nonce();
    const first = await pass(real);
    check(first === "queued", `queued: pass 1 "queued" (got "${first}")`);
    check((await balance()) === b0, "queued: recipient not paid yet");
    check(
      alerts.length === 1 &&
        alerts[0].includes("completeInboundQueuedTransfer") &&
        alerts[0].includes(`${formatUnits(amount, decimals)} EURC`),
      `queued: one alert naming completeInboundQueuedTransfer and ${formatUnits(amount, decimals)} EURC`,
    );
    const second = await pass(real);
    check(second === "queued", `queued: pass 2 "queued", never "already-delivered" (got "${second}")`);
    check((await nonce()) === n0 + 1, "queued: pass 2 sent nothing");
  });

  await scenario("precheck-queued", async () => {
    await setOneTokenLimit();
    const b0 = await balance();
    const n0 = await nonce();
    pc.simulateContract = async (args: unknown) => {
      await sendAs(OTHER, route.transceiver, deliverData);
      return original.simulate(args);
    };
    const outcome = await pass(real);
    check(outcome === "queued", `precheck-queued: "queued" (got "${outcome}")`);
    check((await nonce()) === n0, "precheck-queued: nothing sent");
    check((await balance()) === b0, "precheck-queued: recipient not paid yet");
    check(alerts.length === 1 && alerts[0].includes("completeInboundQueuedTransfer"), "precheck-queued: one alert");
  });

  await scenario("forged", async () => {
    const forged = Buffer.from(real.bytes);
    const body = 6 + forged.readUInt8(5) * 66;
    forged[body + 51 + 141 + 7] ^= 0x01; // last byte of the transfer amount
    const vaa = parseVaa(forged);
    const n0 = await nonce();
    const runs: string[] = [];
    const alertsAfter: number[] = [];
    for (let attempts = 1; attempts <= 3; attempts++) {
      try {
        runs.push(await runOutbound(route, vaa, clients, queue, logger, deliverOpts(), { attempts, maxAttempts: 3 }));
      } catch (e) {
        runs.push("THROW");
      }
      alertsAfter.push(alerts.length);
    }
    check(runs.every((r) => r === "THROW"), `forged: every run throws for a retry (got ${runs.join(", ")})`);
    check((await nonce()) === n0, "forged: nothing sent in 3 runs");
    check(
      alertsAfter.join(",") === "0,0,1" && alerts[0].includes("gave up after 3 attempts"),
      `forged: alert only on the last run (alerts after each run: ${alertsAfter.join(",")})`,
    );
  });

  logger.info(failures === 0 ? "PASS" : `FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  logger.error((e as Error).message);
  process.exit(1);
});
