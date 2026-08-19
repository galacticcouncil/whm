/**
 * PROBE (Basejump direct delivery): the Hydration half of the direct Base→Hydration corridor —
 * `Basejump.completeTransfer` (fast-path VAA) → `_executeTransfer` → `BasejumpLanding.transfer`
 * → DISPATCH precompile `0x0401` → `currencies.transfer` → recipient's asset-44 balance.
 *
 * WHY CHOPSTICKS AND NOT ANVIL. An anvil `--fork-url` of Hydration cannot run this at all: the
 * asset-44 ERC20 (`0x…010000002C`) and the DISPATCH precompile (`0x0401`) are Substrate *runtime*
 * precompiles, not EVM bytecode, so a forked EVM sees `0x00` / empty code and the landing reverts
 * on its first `balanceOf`. Only a Substrate-level fork executes them.
 *
 * EVERYTHING HERE IS THE REAL DEPLOYED CODE — including the message core at 0x3792a6…82a1. We do
 * not mock it. Guardian signatures cannot be forged, so instead we swap the core's *guardian set*
 * for a single key we hold, via `dev_setStorage` into `EVM.AccountStorages`, and then submit a
 * properly-formed VAA that the core's own `parseAndVerifyVM` verifies for real: real header, real
 * double-keccak body hash, real ecrecover, real quorum, real replay protection. Only the trust root
 * is substituted — the verification path is untouched.
 *
 * Storage layout of the core's `State` (verified live against 0x3792a6…82a1):
 *   slot 0  provider.chainId(u16) | governanceChainId(u16)   → 0x010049  (73 / 1)
 *   slot 2  mapping(uint32 => GuardianSet) guardianSets
 *   slot 3  guardianSetIndex(u32) | guardianSetExpiry(u32)    → 7
 *   slot 7  messageFee                                        → 0
 *   guardianSets[i]      = keccak256(abi.encode(i, 2))  → .keys.length (19 on set 7)
 *   guardianSets[i].keys = keccak256(that)              → keys[0] = 0x5893b5a7… (guardian #0)
 *
 *   npx tsx chopsticks/probes/_probeBasejumpDelivery.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  concatHex,
  encodeAbiParameters,
  encodeDeployData,
  encodeFunctionData,
  keccak256,
  numberToHex,
  pad,
  type Hex,
} from "viem";
import { privateKeyToAccount, sign } from "viem/accounts";
import { AccountId } from "polkadot-api";

import { configs } from "../lib/configs";
import { spawnForks, teardownForks, type Network } from "../lib/network";
import { EthClient } from "../lib/eth/client";
import { getTokenBalance } from "../lib/queries";
import { logEvents, type EventRecord } from "../lib/events";

// ─── Constants ───────────────────────────────────────────────────

const HYDRATION_EVM_CHAIN_ID = 222222;
const BASE_CHAIN_ID = 30;

/** The REAL deployed core on Hydration — not a mock. */
const MESSAGE_CORE = "0x3792a6d63c31941B2805181771795D9176fA82A1" as Hex;
/** Its current guardian set index (slot 3), read live. */
const GUARDIAN_SET_INDEX = 7;

const EURC_BASE = "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42" as Hex;
/** Hydration asset 44 (EURC). currencyId = uint32(uint160(addr)) = 44. */
const EURC_HYDRATION = "0x000000000000000000000000000000010000002c" as Hex;
const EURC_ASSET_ID = 44;
/** WETH (asset 20, 18dp) — Hydration EVM gas is denominated in this, not HDX. */
const WETH_ASSET_ID = 20;

const POOL_AMOUNT = 10_000_000_000n; // 10,000 EURC (6dp)
const GROSS = 100_000_000n; //  100 EURC
const FEE = 100_000n; //    0.1 EURC
const NET = GROSS - FEE; //   99.9 EURC

/** Throwaway signers — the fork needs no ContractDeployer slot. */
const DEPLOYER_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
/** The key we install as the sole guardian, so we can sign a VAA the real core accepts. */
const GUARDIAN_PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;

/** Alice — the AccountId32 that should receive the payout. */
const RECIPIENT = "0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d" as Hex;
/** Stand-in for the Base-side Basejump (only needs to match authorizedEmitters). */
const SOURCE_BASEJUMP = "0x69fc8f60f8685129a0ceea6635fdc9ae7ccde54b" as Hex;

const HYDRATION_SS58_PREFIX = 63;

// ─── Artifacts ───────────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../../contracts/out");

interface Artifact {
  abi: unknown[];
  bytecode: { object: Hex };
}

const artifact = (path: string): Artifact =>
  JSON.parse(readFileSync(resolve(OUT, path), "utf8")) as Artifact;

const BASEJUMP = artifact("Basejump.sol/Basejump.json");
const LANDING = artifact("BasejumpLanding.sol/BasejumpLanding.json");
const PROXY = artifact("ERC1967Proxy.sol/ERC1967Proxy.json");

// ─── Helpers ─────────────────────────────────────────────────────

/** Hydration's unbound-H160 → AccountId32 mapping: b"ETH\0" ++ h160 ++ [0u8;8]. */
const truncatedEvmAccount = (h160: Hex): Hex =>
  `0x45544800${h160.slice(2).toLowerCase()}${"00".repeat(8)}` as Hex;

const ss58 = (pubkey: Hex): string => AccountId(HYDRATION_SS58_PREFIX).dec(pubkey);

const slotHex = (n: bigint): Hex => pad(numberToHex(n), { size: 32 });

/**
 * Storage overrides that replace the core's 19-guardian set with a single key we control.
 * Quorum for n=1 is (1*2)/3+1 = 1, so one signature suffices. `expirationTime` (base+1) is already
 * 0 and we keep the CURRENT set index, so `verifyVM`'s expiry branch is never taken.
 */
function guardianSetOverride(guardian: Hex): Record<string, unknown> {
  const base = BigInt(
    keccak256(
      encodeAbiParameters(
        [{ type: "uint256" }, { type: "uint256" }],
        [BigInt(GUARDIAN_SET_INDEX), 2n],
      ),
    ),
  );
  const keysData = BigInt(keccak256(slotHex(base)));

  return {
    EVM: {
      AccountStorages: [
        [[MESSAGE_CORE, slotHex(base)], slotHex(1n)], // keys.length = 1
        [[MESSAGE_CORE, slotHex(keysData)], pad(guardian, { size: 32 })], // keys[0]
      ],
    },
  };
}

/**
 * Assemble a VAA the real core will verify.
 *
 *   body = timestamp | nonce | emitterChainId | emitterAddress | sequence | consistencyLevel | payload
 *   hash = keccak256(keccak256(body))          ← the core double-hashes
 *   vaa  = version | guardianSetIndex | sigCount | (guardianIndex | r | s | recoveryId)… | body
 */
async function buildSignedVaa(opts: {
  emitterChain: number;
  emitter: Hex;
  sequence: bigint;
  consistencyLevel: number;
  payload: Hex;
}): Promise<{ vaa: Hex; hash: Hex }> {
  const body = concatHex([
    pad(numberToHex(Math.floor(Date.now() / 1000)), { size: 4 }), // timestamp
    pad(numberToHex(0), { size: 4 }), // nonce
    pad(numberToHex(opts.emitterChain), { size: 2 }),
    pad(opts.emitter, { size: 32 }),
    pad(numberToHex(opts.sequence), { size: 8 }),
    pad(numberToHex(opts.consistencyLevel), { size: 1 }),
    opts.payload,
  ]);

  const hash = keccak256(keccak256(body));
  const { r, s, v } = await sign({ hash, privateKey: GUARDIAN_PK });
  const recoveryId = Number(v! - 27n);

  const vaa = concatHex([
    pad(numberToHex(1), { size: 1 }), // version
    pad(numberToHex(GUARDIAN_SET_INDEX), { size: 4 }),
    pad(numberToHex(1), { size: 1 }), // signature count
    pad(numberToHex(0), { size: 1 }), // guardian index
    pad(r, { size: 32 }),
    pad(s, { size: 32 }),
    pad(numberToHex(recoveryId), { size: 1 }),
    body,
  ]);

  return { vaa, hash };
}

/** The fast-path payload: abi.encode(IBasejumpCore.TransferPayload). */
function transferPayload(sourceAsset: Hex, amount: bigint, recipient: Hex, seq: bigint): Hex {
  return encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "sourceAsset", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "recipient", type: "bytes32" },
          { name: "transferSequence", type: "uint64" },
          { name: "data", type: "bytes" },
        ],
      },
    ],
    [{ sourceAsset, amount, recipient, transferSequence: seq, data: "0x" }],
  );
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Read a block's events, retrying through papi's chainHead pinning lag. */
async function eventsAt(net: Network, at: string, tries = 12): Promise<EventRecord[]> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return (await net.client.getUnsafeApi().query.System.Events.getValue({ at })) as EventRecord[];
    } catch (e) {
      lastErr = e;
      await sleep(300);
    }
  }
  throw lastErr;
}

/** Did this block contain a successful Ethereum.Executed? (papi decodes the field as `exit_reason`) */
function evmSucceeded(events: EventRecord[]): boolean {
  return events.some(({ event }) => {
    const ev = event as { type: string; value: { type: string; value?: { exit_reason?: unknown } } };
    if (ev.type !== "Ethereum" || ev.value?.type !== "Executed") return false;
    const reason = ev.value.value?.exit_reason as { type?: string } | undefined;
    return reason?.type === "Succeed";
  });
}

// ─── Probe ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  const nets = await spawnForks([configs.hydration]);
  const { hydration } = nets;

  try {
    const account = privateKeyToAccount(DEPLOYER_PK);
    const guardian = privateKeyToAccount(GUARDIAN_PK);
    const client = new EthClient(hydration, account, { chainId: HYDRATION_EVM_CHAIN_ID });
    const deployerSub = ss58(truncatedEvmAccount(account.address));

    console.log(`\n🥢 Basejump direct-delivery probe (real deployed core)`);
    console.log(`   core          : ${MESSAGE_CORE}`);
    console.log(`   deployer H160 : ${account.address}`);
    console.log(`   guardian      : ${guardian.address}`);

    // ── fund the deployer: HDX for existence, WETH(20) because EVM gas is WETH-denominated ──
    await hydration.setStorage({
      System: {
        Account: [[[deployerSub], { providers: 1, data: { free: 1_000_000n * 10n ** 12n } }]],
      },
      Tokens: { Accounts: [[[deployerSub, WETH_ASSET_ID], { free: 1_000n * 10n ** 18n }]] },
    });

    // ── swap the core's guardian set for our single key ──
    await hydration.setStorage(guardianSetOverride(guardian.address));
    console.log(`   guardian set ${GUARDIAN_SET_INDEX}: 19 keys → 1 (ours), quorum 1`);

    // ── deploy landing + receiver, both behind ERC1967 proxies ──
    const { address: landingImpl } = await client.deploy(LANDING.bytecode.object);
    const { address: landing } = await client.deploy(
      encodeDeployData({
        abi: PROXY.abi,
        bytecode: PROXY.bytecode.object,
        args: [landingImpl, encodeFunctionData({ abi: LANDING.abi, functionName: "initialize" })],
      }) as Hex,
    );
    console.log(`\n   BasejumpLanding   ${landing}`);

    const { address: bjImpl } = await client.deploy(BASEJUMP.bytecode.object);
    const { address: basejump, res: bjRes } = await client.deploy(
      encodeDeployData({
        abi: PROXY.abi,
        bytecode: PROXY.bytecode.object,
        args: [
          bjImpl,
          encodeFunctionData({
            abi: BASEJUMP.abi,
            functionName: "initialize",
            args: [MESSAGE_CORE, "0x0000000000000000000000000000000000000000"],
          }),
        ],
      }) as Hex,
    );
    console.log(`   Basejump receiver ${basejump}`);

    const deployEvents = await eventsAt(hydration, bjRes.blockHash);
    if (!evmSucceeded(deployEvents)) {
      logEvents(deployEvents);
      throw new Error("receiver deploy did not succeed");
    }

    // ── wire, exactly as migrations/definitions/basejump-base does ──
    const wire = async (to: Hex, abi: unknown[], functionName: string, args: unknown[]) => {
      const res = await client.call(to, encodeFunctionData({ abi, functionName, args }) as Hex);
      const evs = await eventsAt(hydration, res.blockHash);
      if (!evmSucceeded(evs)) {
        logEvents(evs);
        throw new Error(`${functionName} failed`);
      }
    };

    await wire(basejump, BASEJUMP.abi, "setAuthorizedEmitter", [
      BASE_CHAIN_ID,
      pad(SOURCE_BASEJUMP, { size: 32 }),
    ]);
    await wire(basejump, BASEJUMP.abi, "setLanding", [pad(landing, { size: 32 })]);
    await wire(landing, LANDING.abi, "setAuthorizedBridge", [basejump, true]);
    await wire(landing, LANDING.abi, "setDestAsset", [EURC_BASE, EURC_HYDRATION]);
    console.log(`   wired: emitter(30) · landing · authorizedBridge · destAssetFor(EURC)`);

    // ── fund the pool (asset 44) ──
    const landingSub = ss58(truncatedEvmAccount(landing));
    await hydration.setStorage({
      Tokens: { Accounts: [[[landingSub, EURC_ASSET_ID], { free: POOL_AMOUNT }]] },
    });

    const recipientSub = ss58(RECIPIENT);
    const poolBefore = await getTokenBalance(hydration, landingSub, EURC_ASSET_ID);
    const recipBefore = await getTokenBalance(hydration, recipientSub, EURC_ASSET_ID);
    console.log(`\n   pool before      ${poolBefore}`);
    console.log(`   recipient before ${recipBefore}`);

    // ── deliver a genuinely signed fast-path VAA through the real core ──
    const { vaa } = await buildSignedVaa({
      emitterChain: BASE_CHAIN_ID,
      emitter: SOURCE_BASEJUMP,
      sequence: 1n,
      consistencyLevel: 200,
      payload: transferPayload(EURC_BASE, NET, RECIPIENT, 10n),
    });
    console.log(`   VAA ${(vaa.length - 2) / 2} bytes, 1 signature, set ${GUARDIAN_SET_INDEX}`);

    const res = await client.call(
      basejump,
      encodeFunctionData({
        abi: BASEJUMP.abi,
        functionName: "completeTransfer",
        args: [vaa],
      }) as Hex,
    );
    const events = await eventsAt(hydration, res.blockHash);
    const ok = evmSucceeded(events);
    console.log(`\n   completeTransfer  ${ok ? "✅ Succeed" : "❌ failed"}  @ ${res.blockHash}`);
    if (!ok) logEvents(events);

    const poolAfter = await getTokenBalance(hydration, landingSub, EURC_ASSET_ID, res.blockHash);
    const recipAfter = await getTokenBalance(hydration, recipientSub, EURC_ASSET_ID, res.blockHash);

    console.log(`\n🥢 Result`);
    console.log(`   pool       ${poolBefore} → ${poolAfter}   (Δ ${poolAfter - poolBefore})`);
    console.log(`   recipient  ${recipBefore} → ${recipAfter}   (Δ ${recipAfter - recipBefore})`);
    console.log(`   expected   Δ recipient = +${NET}, Δ pool = -${NET}`);
    console.log(
      recipAfter - recipBefore === NET && poolBefore - poolAfter === NET
        ? `\n🥢 ✅ DIRECT DELIVERY WORKS — real core verified the VAA, dispatch moved asset 44.`
        : `\n🥢 ❌ balances did not move as expected.`,
    );

    // ── replay protection: the same VAA must not pay twice ──
    const replay = await client.call(
      basejump,
      encodeFunctionData({
        abi: BASEJUMP.abi,
        functionName: "completeTransfer",
        args: [vaa],
      }) as Hex,
    );
    const replayEvents = await eventsAt(hydration, replay.blockHash);
    const replayPaid = await getTokenBalance(
      hydration,
      recipientSub,
      EURC_ASSET_ID,
      replay.blockHash,
    );
    console.log(`\n🥢 Replay of the same VAA`);
    console.log(`   executed   ${evmSucceeded(replayEvents) ? "❌ SUCCEEDED (bad)" : "✅ rejected"}`);
    console.log(
      `   recipient  ${replayPaid} ${replayPaid === recipAfter ? "✅ unchanged" : "❌ paid twice"}`,
    );

    // ── R3: a shortfall QUEUES and consumes the VAA — it does NOT revert ──
    //    This is the one hazard atomicity does not cover, so prove it on the real runtime.
    const oversized = poolAfter + 1_000_000n;
    const { vaa: bigVaa } = await buildSignedVaa({
      emitterChain: BASE_CHAIN_ID,
      emitter: SOURCE_BASEJUMP,
      sequence: 2n,
      consistencyLevel: 200,
      payload: transferPayload(EURC_BASE, oversized, RECIPIENT, 11n),
    });
    const queued = await client.call(
      basejump,
      encodeFunctionData({
        abi: BASEJUMP.abi,
        functionName: "completeTransfer",
        args: [bigVaa],
      }) as Hex,
    );
    const queuedEvents = await eventsAt(hydration, queued.blockHash);
    const poolQ = await getTokenBalance(hydration, landingSub, EURC_ASSET_ID, queued.blockHash);
    const recipQ = await getTokenBalance(hydration, recipientSub, EURC_ASSET_ID, queued.blockHash);
    console.log(`\n🥢 Shortfall (${oversized} > pool ${poolAfter})`);
    console.log(
      `   executed   ${evmSucceeded(queuedEvents) ? "✅ Succeed — VAA consumed, queued" : "❌ reverted"}`,
    );
    console.log(`   pool       ${poolQ} ${poolQ === poolAfter ? "✅ untouched" : "❌ moved"}`);
    console.log(`   recipient  ${recipQ} ${recipQ === recipAfter ? "✅ unpaid" : "❌ paid"}`);
    console.log(
      `   ⇒ a drained pool silently queues with no revert signal. Nothing calls fulfillPending()`,
    );
    console.log(`     automatically — the keeper in mrelayer is what closes this (R3).`);
  } finally {
    await teardownForks(nets);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("PROBE ERROR:", e?.stack ?? e?.message ?? e);
    process.exit(1);
  });
