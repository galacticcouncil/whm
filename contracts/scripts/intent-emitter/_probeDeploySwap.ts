/**
 * PROBE: full deploy + swap of IntentEmitter on a chopsticks Hydration fork, driven by real
 * viem-signed eth transactions submitted as `pallet_ethereum::transact` (the eth_sendRawTransaction
 * path). Mirrors how hardhat/foundry deploy via the EVM RPC. Throwaway.
 *
 *   spawn → fund deployer → deploy impl + proxy (CREATE) → setProxy/setRouter → approve + swapAndBridge
 *
 *   npx tsx contracts/scripts/intent-emitter/_probeDeploySwap.ts
 */
import {
  encodeDeployData,
  encodeEventTopics,
  encodeFunctionData,
  keccak256,
  pad,
  toHex,
  type Abi,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { h160, erc20, acc } from "@galacticcouncil/common";

import { configs } from "@whm/chopsticks/configs";
import { EthClient, type EthTxResult } from "@whm/chopsticks/eth";
import {
  checkIfEthereumExecuted,
  checkIfEvmLog,
  checkIfQueueFailed,
  checkIfXcmError,
  checkIfXcmSent,
  logEvents,
  type EventRecord,
} from "@whm/chopsticks/events";
import { spawnForks, teardownForks, type Network } from "@whm/chopsticks/network";
import { getEventsAt, getTokenBalance } from "@whm/chopsticks/queries";

import intentEmitterJson from "../../out/IntentEmitter.sol/IntentEmitter.json";
import erc1967ProxyJson from "../../out/ERC1967Proxy.sol/ERC1967Proxy.json";
import { toJson } from "@whm/chopsticks";

const { H160 } = h160;
const { ERC20 } = erc20;

// --- Abis --------------------------------------------------------

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
const GLMR = 16;

const AMOUNT_IN = 100n * 10n ** 10n; // 100 DOT (10 dec)
const MIN_ETH_OUT = 1n;
const INTENT_ID = keccak256(toHex("intent-emitter-chopsticks-test"));
const INTENT_DEPOSIT_ADDRESS = "0x000000000000000000000000000000000000dead" as const;

const BASEJUMP_PROXY = "0x00000000000000000000000000000000ba53ec00" as const;
const INTENT_ROUTER = pad("0x00000000000000000000000000000000c0ffee00", { size: 32 }) as Hex;

const FUND = { hdx: 1_000n * 10n ** 12n, dot: 1_000n * 10n ** 10n, weth: 100n * 10n ** 18n };

const PK = "0xac0974bec39a17e36ba4a6b4d238ff944babceb0f7d40bef0b46e16b3c5f1b3c";
const account = privateKeyToAccount(PK);

const emitterAbi = intentEmitterJson.abi as Abi;
const emitterBytecode = (intentEmitterJson as { bytecode: { object: Hex } }).bytecode.object;
const proxyAbi = erc1967ProxyJson.abi as Abi;
const proxyBytecode = (erc1967ProxyJson as { bytecode: { object: Hex } }).bytecode.object;

const BRIDGE_INITIATED = encodeEventTopics({ abi: emitterAbi, eventName: "BridgeInitiated" })[0]!;

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
  const nets = await spawnForks([configs.hydration, configs.moonbeam]);
  const { hydration, moonbeam } = nets;

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

    const { address: implAddr, res: implRes } = await client.deploy(emitterBytecode);
    await check(hydration, implRes, `deploy ${implAddr}`);

    const initData = encodeFunctionData({ abi: emitterAbi, functionName: "initialize", args: [] });
    const proxyInitCode = encodeDeployData({
      abi: proxyAbi,
      bytecode: proxyBytecode,
      args: [implAddr, initData],
    });
    const { address: proxyAddr, res: proxyRes } = await client.deploy(proxyInitCode);
    await check(hydration, proxyRes, `deploy ${proxyAddr}`);

    // ── configure proxy ────────────────────────────────────────────
    console.log("\n🥢 IntentEmitter setup");

    const setProxy = await client.call(
      proxyAddr,
      encodeFunctionData({ abi: emitterAbi, functionName: "setProxy", args: [BASEJUMP_PROXY] }),
    );
    await check(hydration, setProxy, "setProxy");

    const setRouter = await client.call(
      proxyAddr,
      encodeFunctionData({ abi: emitterAbi, functionName: "setRouter", args: [INTENT_ROUTER] }),
    );
    await check(hydration, setRouter, "setRouter");

    // ── approve + swapAndBridge ────────────────────────────────────
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

    const swapAndBridge = await client.call(
      proxyAddr,
      encodeFunctionData({
        abi: emitterAbi,
        functionName: "swapAndBridge",
        args: [DOT, AMOUNT_IN, MIN_ETH_OUT, INTENT_ID, INTENT_DEPOSIT_ADDRESS],
      }),
    );
    await check(hydration, swapAndBridge, "swapAndBridge");

    const swapAndBridgeEvents = await getEventsAt(hydration, swapAndBridge.blockHash);
    const isBridgeInitiated = checkIfEvmLog(swapAndBridgeEvents, BRIDGE_INITIATED);
    const isXcmSent = checkIfXcmSent(swapAndBridgeEvents);

    console.log(`   ${isBridgeInitiated ? "✅" : "❌"} BridgeInitiated emitted`);
    console.log(`   ${isXcmSent ? "✅" : "❌"} bridge XCM sent`);

    // ── Did the swap move value? (race-free state reads at the swap block) ──
    const contractAcct = H160.toAccount(proxyAddr);
    const contractWeth = await getTokenBalance(
      hydration,
      contractAcct,
      WETH,
      swapAndBridge.blockHash,
    );
    const contractGlmr = await getTokenBalance(
      hydration,
      contractAcct,
      GLMR,
      swapAndBridge.blockHash,
    );
    const deployerDot = await getTokenBalance(
      hydration,
      deployerAcct,
      DOT,
      swapAndBridge.blockHash,
    );
    const deployerWeth = await getTokenBalance(
      hydration,
      deployerAcct,
      WETH,
      swapAndBridge.blockHash,
    );

    console.log(`\n🥢 Post-swap:`);
    console.log(`   contract WETH ${contractWeth}`);
    console.log(`   contract GLMR ${contractGlmr}`);
    console.log(`   deployer DOT  ${deployerDot} (was ${FUND.dot})`);
    console.log(`   deployer WETH  ${deployerWeth} (was ${FUND.weth})`);

    // ── relay the bridge XCM → Moonbeam ────────────────────────────
    console.log("\n🥢 Relay → Moonbeam");
    await hydration.newBlock(); // Flush HRMP outbound
    const moonHash = await moonbeam.newBlock(); // Moonbeam receives + processes

    const moonEventsRaw = await moonbeam.client
      .getUnsafeApi()
      .query.System.Events.getValue({ at: moonHash });
    const moonEvents = moonEventsRaw as EventRecord[];

    const xcmFailed = checkIfQueueFailed(moonEvents) || checkIfXcmError(moonEvents);

    console.log(`   ${!xcmFailed ? "✅" : "❌"} Moonbeam processed bridge XCM`);

    const mda = acc.getMultilocationDerivatedAccount(2034, contractAcct, 1, true) as Hex;
    const mdaAccount = await moonbeam.client
      .getUnsafeApi()
      .query.System.Account.getValue(mda, { at: moonHash });
    console.log(`   MDA ${mda} GLMR ${toJson(mdaAccount)}`);

    if (xcmFailed) {
      logEvents(moonEvents);
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
