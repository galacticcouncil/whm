/**
 * PROBE: full deploy + order placement of IntentEmitter on a chopsticks Hydration fork, driven by
 * real viem-signed eth transactions submitted as `pallet_ethereum::transact` (the
 * eth_sendRawTransaction path). Mirrors how hardhat/foundry deploy via the EVM RPC. Throwaway.
 *
 * v2 settles over NTT straight from Hydration — no XCM hop and no separate fee-asset leg — so this
 * only needs the one fork. Two Wormhole messages should come out of `placeOrder`: the transceiver's
 * settlement and the emitter's own forwarding instruction.
 *
 * Uses the REAL prod Wormhole core + WETH NttManager so the measured gas reflects reality.
 *
 *   spawn → fund deployer → deploy impl + proxy (CREATE) → setNttManager/setIntentReceiver
 *         → approve + placeOrder
 *
 *   npx tsx chopsticks/probes/_probeIntentEmitter.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { encodeDeployData, encodeEventTopics, encodeFunctionData, type Abi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { h160, erc20 } from "@galacticcouncil/common";
import { forgeArtifact } from "@whm/common/evm/artifacts";

import { configs } from "../lib/configs";
import { spawnForks, teardownForks, type Network } from "../lib/network";
import { EthClient, type EthTxResult } from "../lib/eth";
import { checkIfEthereumExecuted, checkIfEvmLog, findEvmLogs, logEvents } from "../lib/events";
import { getEventsAt, getTokenBalance } from "../lib/queries";

const { H160 } = h160;
const { ERC20 } = erc20;

// ─── Artifacts ───────────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../../contracts/out");

interface Artifact {
  abi: unknown[];
  bytecode: { object: Hex };
}

const artifact = (path: string): Artifact =>
  JSON.parse(readFileSync(resolve(OUT, path), "utf8")) as Artifact;

const EMITTER = artifact("IntentEmitter.sol/IntentEmitter.json");
const PROXY = forgeArtifact("ERC1967Proxy");

const emitterAbi = EMITTER.abi as Abi;
const proxyAbi = PROXY.abi as Abi;

// --- Abis --------------------------------------------------------

// Wormhole core — only the event `placeOrder`'s two legs land in.
const WORMHOLE_ABI = [
  {
    name: "LogMessagePublished",
    type: "event",
    inputs: [
      { name: "sender", type: "address", indexed: true },
      { name: "sequence", type: "uint64", indexed: false },
      { name: "nonce", type: "uint32", indexed: false },
      { name: "payload", type: "bytes", indexed: false },
      { name: "consistencyLevel", type: "uint8", indexed: false },
    ],
  },
] as const;

const ERC20_APPROVE_ABI = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ type: "address" }, { type: "uint256" }],
    outputs: [{ type: "bool" }],
  },
] as const;

// ─── Constants ───────────────────────────────────────────────────

const CHAIN_ID = 222222;

const DOT = 5;
const WETH = 20;

const AMOUNT_IN = 100n * 10n ** 10n; // 100 DOT (10 dec)
const MIN_ETH_OUT = 1n;
const DEPOSIT_ADDRESS = "0x000000000000000000000000000000000000dead" as const;
const MAX_RELAY_FEE = 0n; // probe: no dest relay fee

// Real prod addresses so the NTT leg encodes against the actual config.
const WORMHOLE_CORE = "0x3792a6d63c31941B2805181771795D9176fA82A1" as const; // Hydration core bridge
const NTT_MANAGER = "0xB5cEf790D52A57fa619eD96eDd64c5328F3DCFb7" as const; // Hydration WETH NttManager
// Not deployed for v2 yet — the emitter only stores it, so any address exercises the same path.
const INTENT_RECEIVER = "0x000000000000000000000000000000000000beef" as const;

const FUND = { hdx: 1_000n * 10n ** 12n, dot: 1_000n * 10n ** 10n, weth: 100n * 10n ** 18n };

const PK = "0xac0974bec39a17e36ba4a6b4d238ff944babceb0f7d40bef0b46e16b3c5f1b3c";
const account = privateKeyToAccount(PK);

const ORDER_PLACED = encodeEventTopics({ abi: emitterAbi, eventName: "OrderPlaced" })[0]!;
const LOG_MESSAGE_PUBLISHED = encodeEventTopics({
  abi: WORMHOLE_ABI as unknown as Abi,
  eventName: "LogMessagePublished",
})[0]!;

// ─── Helpers ─────────────────────────────────────────────────────

async function check(net: Network, res: EthTxResult, label: string) {
  const events = await getEventsAt(net, res.blockHash);
  const ok = checkIfEthereumExecuted(events);
  console.log(`   ${ok ? "✅" : "❌"} ${label} @#${res.blockNumber}`);
  if (!ok) {
    logEvents(events);
  }
}

async function main(): Promise<void> {
  const nets = await spawnForks([configs.hydration]);
  const { hydration } = nets;

  try {
    const deployer = account.address;
    const deployerAcct = H160.toAccount(deployer);
    console.log("\n🥢 Deployer:", deployer);

    await hydration.setStorage({
      System: {
        Account: [[[deployerAcct], { providers: 1, sufficients: 1, data: { free: FUND.hdx } }]],
      },
      Tokens: {
        Accounts: [
          [[deployerAcct, WETH], { free: FUND.weth }],
          [[deployerAcct, DOT], { free: FUND.dot }],
        ],
      },
    });

    const client = new EthClient(hydration, account, { chainId: CHAIN_ID, gas: 15_000_000n });

    // ── deploy impl + proxy ────────────────────────────────────────
    console.log("\n🥢 IntentEmitter deploy");

    const { address: implAddr, res: implRes } = await client.deploy(EMITTER.bytecode.object);
    await check(hydration, implRes, `deploy ${implAddr}`);

    const initData = encodeFunctionData({
      abi: emitterAbi,
      functionName: "initialize",
      args: [WORMHOLE_CORE],
    });
    const proxyInitCode = encodeDeployData({
      abi: proxyAbi,
      bytecode: PROXY.bytecode.object,
      args: [implAddr, initData],
    });
    const { address: proxyAddr, res: proxyRes } = await client.deploy(proxyInitCode);
    await check(hydration, proxyRes, `deploy ${proxyAddr}`);

    // ── configure proxy ────────────────────────────────────────────
    console.log("\n🥢 IntentEmitter setup");

    // Reverts unless the manager's token is Hydration WETH, so this also asserts the address.
    const setNttManager = await client.call(
      proxyAddr,
      encodeFunctionData({ abi: emitterAbi, functionName: "setNttManager", args: [NTT_MANAGER] }),
    );
    await check(hydration, setNttManager, "setNttManager");

    const setIntentReceiver = await client.call(
      proxyAddr,
      encodeFunctionData({
        abi: emitterAbi,
        functionName: "setIntentReceiver",
        args: [INTENT_RECEIVER],
      }),
    );
    await check(hydration, setIntentReceiver, "setIntentReceiver");

    // ── approve + placeOrder ───────────────────────────────────────
    console.log("\n🥢 IntentEmitter execution");

    const approve = await client.call(
      ERC20.fromAssetId(DOT) as Hex,
      encodeFunctionData({
        abi: ERC20_APPROVE_ABI as unknown as Abi,
        functionName: "approve",
        args: [proxyAddr, AMOUNT_IN],
      }),
    );
    await check(hydration, approve, "approve DOT");

    // Not payable: the delivery price and message fee come out of the swap output, which works
    // because Hydration's native currency IS WETH.
    const placeOrder = await client.call(
      proxyAddr,
      encodeFunctionData({
        abi: emitterAbi,
        functionName: "placeOrder",
        args: [DOT, AMOUNT_IN, MIN_ETH_OUT, DEPOSIT_ADDRESS, MAX_RELAY_FEE],
      }),
    );
    await check(hydration, placeOrder, "placeOrder");

    const placeEvents = await getEventsAt(hydration, placeOrder.blockHash);
    const isOrderPlaced = checkIfEvmLog(placeEvents, ORDER_PLACED);

    console.log(`   ${isOrderPlaced ? "✅" : "❌"} OrderPlaced emitted`);

    // Both legs leave in this one call: the NTT transceiver's settlement and the emitter's own
    // forwarding instruction. NTT carries no payload, so the destination only ever travels in the
    // second one — a single message means the pair IntentReceiver.processOrder needs is broken.
    const published = findEvmLogs(placeEvents, LOG_MESSAGE_PUBLISHED, WORMHOLE_CORE);
    const senders = published.map((log) => `0x${String(log.topics[1]).slice(-40)}`.toLowerCase());
    const fromEmitter = senders.filter((s) => s === proxyAddr.toLowerCase()).length;
    const bothLegs = published.length === 2 && fromEmitter === 1;

    console.log(
      `   ${bothLegs ? "✅" : "❌"} ${published.length} LogMessagePublished ` +
        `(${fromEmitter} from the emitter, ${published.length - fromEmitter} from the transceiver)`,
    );
    for (const sender of senders) {
      console.log(`      sender ${sender}${sender === proxyAddr.toLowerCase() ? " (emitter)" : ""}`);
    }

    // ── Did the swap move value? (race-free state reads at the swap block) ──
    const contractAcct = H160.toAccount(proxyAddr);
    const contractWeth = await getTokenBalance(hydration, contractAcct, WETH, placeOrder.blockHash);
    const deployerDot = await getTokenBalance(hydration, deployerAcct, DOT, placeOrder.blockHash);
    const deployerWeth = await getTokenBalance(hydration, deployerAcct, WETH, placeOrder.blockHash);

    console.log(`\n🥢 Post-swap:`);
    console.log(`   contract WETH ${contractWeth} (quantization dust + unspent fees)`);
    console.log(`   deployer DOT  ${deployerDot} (was ${FUND.dot})`);
    console.log(`   deployer WETH ${deployerWeth} (was ${FUND.weth})`);

    if (!isOrderPlaced || !bothLegs) {
      logEvents(placeEvents);
    }
  } finally {
    await teardownForks(nets);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("PROBE ERROR:", e?.message ?? e);
    process.exit(1);
  });
