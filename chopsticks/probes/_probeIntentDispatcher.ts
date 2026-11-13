/**
 * PROBE (intents v2 — IntentDispatcher on live Hydration): deploy the dispatcher on a Hydration fork
 * against the live WETH NttManagerWithPayload, the live core bridge and the live DIA feeds, then run
 * ICE's forward the way the lazy executor does — push the WETH to the dispatcher, call `execute` as
 * the owner with ICE's 2M gas — twice, and check:
 *
 *   - `execute` fits ICE's 2M gas (estimate, and a real call capped at 2M);
 *   - one NTT transfer with the forward payload, and one order message from the dispatcher at 202;
 *   - the trim dust left behind against WETH's existential deposit: kept or reaped, `_retained`
 *     tracks it, so the next forward still executes;
 *   - ICE's pallets are in the forked runtime.
 *
 *   forge build (contracts/) first, then:
 *   npx tsx chopsticks/probes/_probeIntentDispatcher.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  bytesToHex,
  createPublicClient,
  decodeAbiParameters,
  encodeAbiParameters,
  encodeDeployData,
  encodeFunctionData,
  getAddress,
  http,
  pad,
  parseAbi,
  toEventSelector,
  type Abi,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { AccountId } from "polkadot-api";

import { configs } from "../lib/configs";
import { spawnForks, teardownForks, type Network } from "../lib/network";
import { EthClient } from "../lib/eth/client";
import { checkIfEthereumExecuted, findEvmLogs, logEvents, type EventRecord } from "../lib/events";

// ─── Artifacts ───────────────────────────────────────────────────

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../../contracts/out");
const artifact = (path: string) => JSON.parse(readFileSync(resolve(OUT, path), "utf8")) as { abi: Abi; bytecode: { object: Hex } };
const DISPATCHER = artifact("IntentDispatcher.sol/IntentDispatcher.json");
const PROXY = artifact("ERC1967Proxy.sol/ERC1967Proxy.json");

// ─── Live Hydration ──────────────────────────────────────────────

/** hydration-ntt ops/tokens/weth — the WETH manager, upgraded to NttManagerWithPayload. */
const MANAGER = "0xB5cEf790D52A57fa619eD96eDd64c5328F3DCFb7" as Hex;
const TRANSCEIVER = "0x8acce9CA511d5D7213F8C3f813B8916087cd00ae" as Hex;
const CORE = "0x3792a6d63c31941B2805181771795D9176fA82A1" as Hex;
const WETH = "0x0000000000000000000000000000000100000014" as Hex;
const WETH_ASSET_ID = 20;
const ETH_USD = getAddress("0x1AF549Fe19A9B73D094173C41e18BF7F357F594b");
const ZEC_USD = getAddress("0xd76f6e296e34ad163439d16731800c3e2c081c6e");

const ICE_GAS = 2_000_000n;
const DEPLOY_GAS = 8_000_000n;
const DEPLOYER_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;

const ZEC = "nep141:zec.omft.near";
const FORWARDER = pad("0xF0F0F0F0F0F0F0F0F0F0F0F0F0F0F0F0F0F0F0F0", { size: 32 });
const DEPOSIT = "0x04624e5890ed9c703D94652E19E4e327E2F4002a" as Hex;
const MIN_ORDER = 10n ** 11n;
const MAX_RELAY_FEE = 10n ** 14n;
/** 0.01 WETH plus trim dust, so something stays behind. */
const AMOUNT_OUT = 10n ** 16n + 12_345n;
const RETAINED_SLOT = pad("0x07", { size: 32 });

const FEED_ABI = parseAbi([
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
  "function decimals() view returns (uint8)",
]);
const ERC20_ABI = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);
const LOG_MESSAGE_PUBLISHED = toEventSelector("LogMessagePublished(address,uint64,uint32,bytes,uint8)");

// ─── Helpers ─────────────────────────────────────────────────────

const ss58 = (h160: Hex): string => AccountId(63).dec(`0x45544800${h160.slice(2).toLowerCase()}${"00".repeat(8)}`);
const eq = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function retry<T>(fn: () => Promise<T>, tries = 12): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries) throw e;
      await sleep(400);
    }
  }
}

const eventsAt = (net: Network, at: string): Promise<EventRecord[]> =>
  retry(() => net.client.getUnsafeApi().query.System.Events.getValue({ at }) as Promise<EventRecord[]>);

/** The `additionalPayload` of a WormholeTransceiver message, or null. */
function transferPayload(hex: Hex): Hex | null {
  const b = Buffer.from(hex.slice(2), "hex");
  const m = b.subarray(70, 70 + b.readUInt16BE(68));
  const ntt = m.subarray(66, 66 + m.readUInt16BE(64));
  return ntt.length > 79 ? (`0x${ntt.subarray(81, 81 + ntt.readUInt16BE(79)).toString("hex")}` as Hex) : null;
}

const results: boolean[] = [];
const record = (step: string, ok: boolean, detail = ""): void => {
  results.push(ok);
  console.log(`   ${ok ? "✅" : "❌"} ${step}${detail ? ` — ${detail}` : ""}`);
};

// ─── Probe ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  const nets = await spawnForks([configs.hydration]);
  const { hydration } = nets;
  try {
    const pub = createPublicClient({ transport: http(hydration.url.replace("ws://", "http://").replace("[::]", "127.0.0.1")) });
    const api = hydration.client.getUnsafeApi();
    const meta = (await (hydration.chain.head as never as { meta: Promise<any> }).meta) as any;
    const abi = DISPATCHER.abi;

    // ── the runtime ──
    console.log("\n── Runtime ──");
    const pallets = Object.keys(meta.tx);
    record("ICE pallets present", pallets.includes("intent") && pallets.includes("lazyExecutor"),
      pallets.filter((p) => /intent|lazy|ice/i.test(p)).join(", "));
    const registry = (await (hydration.chain.head as never as { registry: Promise<any> }).registry) as any;
    const onResolved = (registry.lookup.types as any[]).find((t) =>
      t.type.path.map((p: { toString(): string }) => p.toString()).join("::").endsWith("OnResolved"));
    const variants: string[] = onResolved?.type.def.isVariant
      ? onResolved.type.def.asVariant.variants.map((v: { name: { toString(): string } }) => v.name.toString())
      : [];
    record("OnResolved::Forward in the runtime", variants.includes("Forward"), variants.join(", "));
    const asset = (await retry(() => api.query.AssetRegistry.Assets.getValue(WETH_ASSET_ID))) as { existential_deposit: bigint };
    const ed = BigInt(asset.existential_deposit);
    console.log(`   WETH existential deposit ${ed} wei`);

    // ── feeds ──
    const now = BigInt(Math.floor(Number(await retry(() => api.query.Timestamp.Now.getValue())) / 1000));
    for (const [name, feed] of [["ETH/USD", ETH_USD], ["ZEC/USD", ZEC_USD]] as const) {
      const [, answer, , updatedAt] = await retry(() => pub.readContract({ address: feed, abi: FEED_ABI, functionName: "latestRoundData" }));
      console.log(`   ${name} ${answer} — ${Number(now - updatedAt) / 3600} h old`);
    }

    // ── deploy and wire ──
    const account = privateKeyToAccount(DEPLOYER_PK);
    const client = new EthClient(hydration, account, { chainId: 222222 });
    await hydration.setStorage({
      System: { Account: [[[ss58(account.address)], { providers: 1, data: { free: 10n ** 18n } }]] },
      Tokens: { Accounts: [[[ss58(account.address), WETH_ASSET_ID], { free: 10n ** 21n }]] },
      EVMAccounts: { ContractDeployer: [[[account.address], true]] },
    });

    const impl = await client.signDeploy(DISPATCHER.bytecode.object, DEPLOY_GAS);
    const proxy = await client.signDeploy(
      encodeDeployData({
        abi: PROXY.abi,
        bytecode: PROXY.bytecode.object,
        args: [impl.address, encodeFunctionData({ abi, functionName: "initialize", args: [CORE] })],
      }),
      DEPLOY_GAS,
    );
    const deployed = await eventsAt(hydration, (await client.sendBatch([impl.rawTx, proxy.rawTx])).blockHash);
    const dispatcher = proxy.address;
    console.log(`\n── Deploy ──`);
    record("impl + proxy deployed", checkIfEthereumExecuted(deployed), dispatcher);

    const setup: [string, unknown[]][] = [
      ["setNttManager", [MANAGER]],
      ["setForwarder", [FORWARDER]],
      ["setPriceRoute", [ZEC, { ethFeed: ETH_USD, destFeed: ZEC_USD, destDecimals: 8 }]],
      // Wide for the gas run; the feed ages above are what sets the production value.
      ["setMaxFeedAge", [7n * 86_400n]],
      ["setMinOrderAmount", [MIN_ORDER]],
    ];
    // In sequence: EthClient reads its nonce before the signature resolves.
    const signed: Hex[] = [];
    for (const [fn, args] of setup) {
      signed.push(await client.signCall(dispatcher, encodeFunctionData({ abi, functionName: fn as never, args: args as never }), 300_000n));
    }
    const wired = await eventsAt(hydration, (await client.sendBatch(signed)).blockHash);
    const executed = wired.filter(({ event }) => event.type === "Ethereum" && event.value.type === "Executed" && event.value.value.exit_reason.type === "Succeed");
    record("wired", executed.length === setup.length, `${executed.length}/${setup.length}`);

    // ── ICE's forward, twice: push, then execute as the owner with 2M gas ──
    const terms = {
      owner: account.address,
      quoteId: pad("0x01", { size: 32 }),
      maxSlippageBps: 100,
      minOutPerIn: 0n,
      minDelivery: 1_000_000n,
      deadline: now + 30n * 86_400n,
      recipientKind: 0,
      refundTo: account.address,
      destinationAsset: ZEC,
      recipient: "t1KPVSRgnFHPBWMJLC7taJioN6m5Q6jVBma",
    };
    const encodedTerms = (await retry(() => pub.readContract({ address: dispatcher, abi, functionName: "computeTerms", args: [terms] }))) as Hex;
    const data = encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }, { type: "bytes" }],
      [DEPOSIT, MAX_RELAY_FEE, encodedTerms],
    );
    const executeData = encodeFunctionData({
      abi, functionName: "execute",
      args: [account.address, 1n, WETH, AMOUNT_OUT, WETH, AMOUNT_OUT, data],
    });
    console.log(`   forward data ${(data.length - 2) / 2} bytes (ICE cap 512)`);

    for (const round of [1, 2]) {
      console.log(`\n── Forward ${round} ──`);
      const push = await client.call(WETH, encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [dispatcher, AMOUNT_OUT] }));
      record("push", checkIfEthereumExecuted(await eventsAt(hydration, push.blockHash)));

      const res = await client.sendBatch([await client.signCall(dispatcher, executeData, ICE_GAS)]);
      const evs = await eventsAt(hydration, res.blockHash);
      const ok = checkIfEthereumExecuted(evs);
      // eth_estimateGas searches down from a high cap under Hydration's storage/PoV metering and
      // overstates; the receipt is what the call actually used.
      const receipts = (await retry(() => api.query.Ethereum.CurrentReceipts.getValue({ at: res.blockHash }))) as
        { value: { used_gas: bigint[] } }[] | undefined;
      // U256 as four little-endian u64 limbs.
      const used = receipts?.length
        ? receipts[receipts.length - 1].value.used_gas.reduceRight((acc, limb) => (acc << 64n) + BigInt(limb), 0n)
        : -1n;
      record("execute succeeds at a 2M gas limit", ok, `used ${used} gas`);
      if (!ok) {
        logEvents(evs);
        continue;
      }

      const msgs = findEvmLogs(evs, LOG_MESSAGE_PUBLISHED).map((l) => ({
        sender: getAddress(`0x${String(l.topics[1]).slice(-40)}`),
        args: decodeAbiParameters([{ type: "uint64" }, { type: "uint32" }, { type: "bytes" }, { type: "uint8" }], bytesToHex(l.data)),
      }));
      const transfer = msgs.find((m) => eq(m.sender, TRANSCEIVER));
      const order = msgs.find((m) => eq(m.sender, dispatcher));
      record("NTT transfer carries the forward payload",
        !!transfer && transferPayload(transfer.args[2] as Hex)?.toLowerCase() ===
          `0x01${DEPOSIT.slice(2)}${MAX_RELAY_FEE.toString(16).padStart(32, "0")}`.toLowerCase());
      record("order message from the dispatcher at 202", !!order && order.args[3] === 202 && (order.args[2] as Hex).length === 2 + 73 * 2);

      const held = (await retry(() => pub.readContract({ address: WETH, abi: ERC20_ABI, functionName: "balanceOf", args: [dispatcher] }))) as bigint;
      const retained = BigInt(String(await retry(() => api.query.EVM.AccountStorages.getValue(dispatcher, RETAINED_SLOT))));
      record("_retained == the dispatcher's WETH", retained === held,
        `held ${held} wei (${held === 0n ? "reaped" : held < ed ? "kept below ED" : "kept"}), retained ${retained}`);
    }

    const failed = results.filter((ok) => !ok).length;
    console.log(`\n🥢 ${failed ? "❌" : "✅"} ${results.length - failed}/${results.length}`);
    if (failed) process.exitCode = 1;
  } finally {
    await teardownForks(nets).catch(() => {});
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    console.error("PROBE ERROR:", e?.stack ?? e?.message ?? e);
    process.exit(1);
  });
