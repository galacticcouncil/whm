/**
 * PROBE (Basejump Base EURC go-live): the two governance calls that open the Base → Hydration EURC
 * corridor, enacted on a fork of live Hydration through the real dispatcher, then proven by a
 * fast-path VAA that pays a user in EURC (asset 44) out of the shared landing.
 *
 * The landing `0x70e9…f976` is the live pool. Today it holds no EURC and does not map Base EURC:
 * referendum #404 withdrew the old EURC float and re-seeded it with USDC for the Ethereum corridor.
 * The `basejump-base` migration deploys both ends and stops there; the pool is owned by the
 * emergency admin `0xAA7e…AA7E1`, so two calls remain, and this probe builds and enacts both:
 *
 *   1. Treasury referendum (Treasurer track, `dispatchAsTreasury`): sell USDT for EURC through the
 *      router (USDT into the Hydration money market as aUSDT, aUSDT → HOLLAR → aEURC over two
 *      stableswaps, aEURC out of the money market as EURC), and send the EURC float (`--float`,
 *      default 10,000) to the landing. Same shape as #319, which seeded the first float.
 *   2. TC motion (`dispatchAsEmergencyAdmin(evm.call)`, `EmergencyAdminOrigin` = Root or TC
 *      majority): `landing.setDestAsset(Base EURC, asset 44)`, then
 *      `landing.setAuthorizedBridge(<Base receiver>, true)`. Map before authorizing: an authorized
 *      receiver over an unmapped route reverts every payout until the map lands.
 *
 * Neither call lets a user in: the Base emitter is deployed disarmed (`landing` unset, so
 * `bridgeViaWormhole` reverts before pulling a token) and the Base TC Safe arms it only after
 * both have passed (migration step 011 records that call; the Base side is not forked here). Order
 * among the two is for user experience, not funds: funded before authorized, the first payout
 * never queues for want of a pool. A `batchAll` leg that fails is reported as an event and the
 * batch still completes, so a half-applied motion is possible; it is recoverable (payouts revert
 * and wait), and this probe and the checklist read the resulting state, not the outcome.
 *
 * What runs here:
 *   0. the Base receiver: `--receiver <address>` takes the live one (the `005-deploy-receiver`
 *      proxyAddress from deployments/prod/basejump-base.json); without it, one is deployed and
 *      wired on THIS FORK exactly as steps 005-008 do (initialize, emitter for chain 30, landing,
 *      owner = emergency admin)
 *   1. print the calldata: each EVM input, each dispatcher call, the two `batchAll`s, their
 *      preimage hashes, and the TC `propose` to submit
 *   2. canary BEFORE: a fast-path VAA from the Base emitter reverts and pays nobody (corridor dark)
 *   3. enact the referendum from the Treasurer origin; the pool holds the float
 *   4. enact the motion from a `TechnicalCommittee.Members(threshold, n)` origin; the route is
 *      mapped to asset 44, the receiver is authorized, the Ethereum corridor is untouched
 *   5. canary AFTER: the same VAA pays the recipient the net in EURC and debits the pool by as much
 *
 * Every outcome is read back from state, never from a dispatch result: `dispatch_as_*` reports an
 * inner failure in an event, not in the extrinsic. Guardian signatures cannot be forged, so the
 * canary swaps the message core's guardian SET for one key we hold (as in _probeBasejumpDelivery);
 * the verification path is untouched. The canary is scaffolding, not part of either proposal.
 *
 *   npx tsx chopsticks/probes/_probeBasejumpBaseGoLive.ts [--receiver <address>] [--root] [--float <EURC>]
 *
 * `--root` enacts both from Root instead (what a single Root referendum would do).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  concatHex,
  createPublicClient,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  http,
  isAddress,
  keccak256,
  numberToHex,
  pad,
  parseAbi,
  type Hex,
} from "viem";
import { privateKeyToAccount, sign } from "viem/accounts";
import { AccountId } from "polkadot-api";

import { configs } from "../lib/configs";
import { spawnForks, teardownForks, type Network } from "../lib/network";
import { EthClient } from "../lib/eth/client";
import { logEvents, type EventRecord } from "../lib/events";
import { toJson } from "../lib/utils";

// ─── Live deployment ─────────────────────────────────────────────

const HYDRATION_EVM_CHAIN_ID = 222222;
const BASE_WORMHOLE_ID = 30;

const MESSAGE_CORE = "0x3792a6d63c31941B2805181771795D9176fA82A1" as Hex;
const GUARDIAN_SET_INDEX = 7;

const LANDING = "0x70e9b12c3b19cb5f0e59984a5866278ab69df976" as Hex;
/** The Ethereum corridor's receiver — must stay authorized; this probe must not touch it. */
const ETH_RECEIVER = "0x35bf3a1b9ac564c8f66c97cea1ee410cd3f97c8a" as Hex;

const EURC_BASE = "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42" as Hex;
const EURC_HYDRATION = "0x000000000000000000000000000000010000002c" as Hex;
const USDC_ETHEREUM = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Hex;
const USDC_HYDRATION = "0x0000000000000000000000000000000100000015" as Hex;
const ZERO = "0x0000000000000000000000000000000000000000" as Hex;

const EURC_ASSET_ID = 44;
const AEURC_ASSET_ID = 1044;
const HOLLAR_ASSET_ID = 222;
const USDC_ASSET_ID = 21;
const USDT_ASSET_ID = 10;
const AUSDT_ASSET_ID = 1002;
const WETH_ASSET_ID = 20;
/** Stableswap pools on the route: [222,1002] and [222,1044]. */
const AUSDT_HOLLAR_POOL = 111;
const AEURC_HOLLAR_POOL = 10044;

const EMERGENCY_ADMIN = "0xAA7e0000000000000000000000000000000AA7E1" as Hex;
/** b"ETH\0" ++ h160 ++ [0u8;8] — the account pallet_evm charges for the admin's gas (unbound H160). */
const EMERGENCY_ADMIN_EVM_ACCOUNT =
  "0x45544800aa7e0000000000000000000000000000000aa7e10000000000000000" as Hex;
/** b"modlpy/trsry" ++ [0u8;20] — the treasury AccountId32. */
const TREASURY_ACCOUNT = `0x6d6f646c70792f7472737279${"00".repeat(20)}` as Hex;

// ─── Proposal parameters ─────────────────────────────────────────

/** The float in whole EURC (`--float`, default 10,000: the size of both earlier floats, #319 EURC and
 *  #404 USDC). The one parameter of the referendum; the purchase and its ceiling follow from it. */
const floatArg = process.argv.indexOf("--float");
const FLOAT_EURC = floatArg >= 0 ? Number(process.argv[floatArg + 1]) : 10_000;
if (!Number.isInteger(FLOAT_EURC) || FLOAT_EURC <= 0) throw new Error("--float needs a whole EURC amount");
const POOL_SEED = BigInt(FLOAT_EURC) * 1_000_000n;
/** EURC needed: (float - the treasury's EURC), rounded UP to 50 EURC, read at the fork block. */
const BUY_STEP = 50_000_000n;
/**
 * USDT sold per EURC needed: 1.14, about 2% over the 1.1163 a 9,050 EURC purchase cost on a fork at
 * Hydration block 16,702,200 (a fork reading — re-measure before submitting). The referendum SELLS
 * this exact USDT with the EURC needed as its minimum out. Not `router.buy`: on the same fork a
 * 19,050 EURC buy with that ceiling failed `Stableswap.InsufficientBalance` while the same purchase
 * as a sell succeeded, so the sell is the form both float sizes share. Any EURC over the minimum
 * stays in the Treasury.
 */
const USDT_PER_EURC_X100 = 114n;
/** The Hydration money market's aEURC token; its EURC balance is what can still be withdrawn. */
const AEURC_TOKEN = "0xCA30f9FF99394C55DEda293df223E3740635C72e" as Hex;

/**
 * USDT → EURC, explicit. Neither end is in the Omnipool, so an empty route fails. The `Aave` legs
 * are the Hydration money market: USDT is supplied as aUSDT, which crosses two stableswaps via
 * HOLLAR into aEURC, which is withdrawn as EURC. Measured on a fork at block 16,702,200: the route
 * through stableswap 100 (USDT → USDC.wh) fails, that pool is nearly empty of USDC.wh.
 */
const USDT_TO_EURC_ROUTE = [
  { pool: { Aave: null }, asset_in: USDT_ASSET_ID, asset_out: AUSDT_ASSET_ID },
  { pool: { Stableswap: AUSDT_HOLLAR_POOL }, asset_in: AUSDT_ASSET_ID, asset_out: HOLLAR_ASSET_ID },
  { pool: { Stableswap: AEURC_HOLLAR_POOL }, asset_in: HOLLAR_ASSET_ID, asset_out: AEURC_ASSET_ID },
  { pool: { Aave: null }, asset_in: AEURC_ASSET_ID, asset_out: EURC_ASSET_ID },
];

/** setDestAsset / setAuthorizedBridge are single SSTOREs; 300k is the margin the earlier motions used. */
const GAS_LIMIT = 300_000n;
/** Must exceed the base fee (~5e6 wei). The admin pays the base fee, not this ceiling. */
const MAX_FEE_PER_GAS = 10_000_000_000n;

// ─── Fork-only scaffolding ───────────────────────────────────────

/** Stand-in Base emitter for a receiver deployed on the fork. With --receiver, the live one is read. */
const FORK_BASE_EMITTER = "0x000000000000000000000000000000000000ba5e" as Hex;
const GROSS = 100_000_000n; // 100 EURC
const FEE = 100_000n; //   0.1 EURC — EURC_FEE_AMOUNT in basejump-base.env
const NET = GROSS - FEE;
const DEPLOYER_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const GUARDIAN_PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
/** Alice. */
const RECIPIENT = "0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d" as Hex;
const HYDRATION_SS58_PREFIX = 63;

const receiverArg = process.argv.indexOf("--receiver");
const RECEIVER_OVERRIDE = receiverArg >= 0 ? process.argv[receiverArg + 1] : undefined;
if (receiverArg >= 0 && !isAddress(RECEIVER_OVERRIDE ?? "")) throw new Error("--receiver needs an address");
const ENACT_AS_ROOT = process.argv.includes("--root");

const HERE = dirname(fileURLToPath(import.meta.url));
const artifact = (name: string) =>
  JSON.parse(readFileSync(resolve(HERE, `../../contracts/out/${name}.sol/${name}.json`), "utf8")) as {
    bytecode: { object: Hex };
  };

const LANDING_ABI = parseAbi([
  "function owner() view returns (address)",
  "function authorizedBridges(address) view returns (bool)",
  "function destAssetFor(address) view returns (address)",
  "function pendingHead() view returns (uint256)",
  "function pendingTail() view returns (uint256)",
  "function setAuthorizedBridge(address,bool)",
  "function setDestAsset(address,address)",
]);
const RECEIVER_ABI = parseAbi([
  "function initialize(address)",
  "function owner() view returns (address)",
  "function landing() view returns (bytes32)",
  "function authorizedEmitters(uint16) view returns (bytes32)",
  "function processedVaas(bytes32) view returns (bool)",
  "function setAuthorizedEmitter(uint16,bytes32)",
  "function setLanding(bytes32)",
  "function setOwner(address)",
  "function completeTransfer(bytes)",
]);
const ERC20_ABI = parseAbi(["function balanceOf(address) view returns (uint256)"]);

// ─── Helpers ─────────────────────────────────────────────────────

const ss58 = (pubkey: Hex): string => AccountId(HYDRATION_SS58_PREFIX).dec(pubkey);
const truncatedEvmAccount = (h160: Hex): Hex =>
  `0x45544800${h160.slice(2).toLowerCase()}${"00".repeat(8)}` as Hex;
const slotHex = (n: bigint): Hex => pad(numberToHex(n), { size: 32 });
const amt = (v: bigint, sym: string): string => `${(Number(v) / 1e6).toFixed(6)} ${sym}`;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A `BoundedVec<u8>` storage value — `compact(len) ++ bytes`; dev_setStorage writes hex verbatim. */
function boundedBytes(hex: string): string {
  const n = (hex.length - 2) / 2;
  const byte = (v: number) => (v & 0xff).toString(16).padStart(2, "0");
  let prefix: string;
  if (n < 1 << 6) prefix = byte(n << 2);
  else if (n < 1 << 14) prefix = byte((n << 2) | 0b01) + byte((n << 2) >> 8);
  else if (n < 1 << 30) prefix = [0, 8, 16, 24].map((s) => byte(((n << 2) | 0b10) >>> s)).join("");
  else throw new Error(`boundedBytes: ${n} exceeds the 4-byte compact mode`);
  return `0x${prefix}${hex.slice(2)}`;
}

async function retry<T>(what: string, fn: () => Promise<T>, tries = 10): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await sleep(500);
    }
  }
  throw new Error(`${what}: ${String((last as Error)?.message ?? last).slice(0, 160)}`);
}

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

const evName = ({ event }: EventRecord): string => {
  const e = event as { type: string; value: { type: string } };
  return `${e.type}.${e.value?.type}`;
};

/** pallet_evm reports success by variant; pallet_ethereum always `Executed` with an exit_reason. */
function evmSucceeded(events: EventRecord[]): boolean {
  return events.some(({ event }) => {
    const ev = event as { type: string; value: { type: string; value?: { exit_reason?: unknown } } };
    if (ev.type === "EVM") return ev.value?.type === "Executed";
    if (ev.type !== "Ethereum" || ev.value?.type !== "Executed") return false;
    return (ev.value.value?.exit_reason as { type?: string } | undefined)?.type === "Succeed";
  });
}

/** Every inner result carried by the dispatcher's *CallDispatched events, in order. */
function dispatchInnerResults(events: EventRecord[]): { ok: boolean; err: string | null }[] {
  const out: { ok: boolean; err: string | null }[] = [];
  for (const { event } of events) {
    const e = event as {
      type: string;
      value: { type: string; value?: { result?: { value?: { error?: unknown } } } };
    };
    if (e.type === "Dispatcher" && e.value?.type?.endsWith("CallDispatched")) {
      const err = e.value.value?.result?.value?.error;
      out.push(err === undefined ? { ok: true, err: null } : { ok: false, err: toJson(err) });
    }
  }
  return out;
}

function asBytes(v: unknown): Uint8Array | undefined {
  if (v instanceof Uint8Array) return v;
  const b = (v as { asBytes?: () => Uint8Array } | undefined)?.asBytes?.();
  return b instanceof Uint8Array ? b : undefined;
}

/** See _probeBasejumpDelivery for the storage-layout derivation of the core's guardian set. */
function guardianSetOverride(guardian: Hex): Record<string, unknown> {
  const base = BigInt(
    keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [BigInt(GUARDIAN_SET_INDEX), 2n])),
  );
  const keysData = BigInt(keccak256(slotHex(base)));
  return {
    EVM: {
      AccountStorages: [
        [[MESSAGE_CORE, slotHex(base)], slotHex(1n)],
        [[MESSAGE_CORE, slotHex(keysData)], pad(guardian, { size: 32 })],
      ],
    },
  };
}

async function buildSignedVaa(opts: { emitterChain: number; emitter: Hex; sequence: bigint; payload: Hex }): Promise<Hex> {
  const body = concatHex([
    pad(numberToHex(Math.floor(Date.now() / 1000)), { size: 4 }),
    pad(numberToHex(0), { size: 4 }),
    pad(numberToHex(opts.emitterChain), { size: 2 }),
    pad(opts.emitter, { size: 32 }),
    pad(numberToHex(opts.sequence), { size: 8 }),
    pad(numberToHex(200), { size: 1 }),
    opts.payload,
  ]);
  const { r, s, v } = await sign({ hash: keccak256(keccak256(body)), privateKey: GUARDIAN_PK });
  return concatHex([
    pad(numberToHex(1), { size: 1 }),
    pad(numberToHex(GUARDIAN_SET_INDEX), { size: 4 }),
    pad(numberToHex(1), { size: 1 }),
    pad(numberToHex(0), { size: 1 }),
    pad(r, { size: 32 }),
    pad(s, { size: 32 }),
    pad(numberToHex(Number(v! - 27n)), { size: 1 }),
    body,
  ]);
}

/** abi.encode(IBasejumpPayload.TransferPayload). */
const transferPayload = (amount: bigint, seq: bigint): Hex =>
  encodeAbiParameters(
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
    [{ sourceAsset: EURC_BASE, amount, recipient: RECIPIENT, transferSequence: seq, data: "0x" }],
  );

const results: { step: string; ok: boolean }[] = [];
const record = (step: string, ok: boolean, detail = ""): boolean => {
  results.push({ step, ok });
  console.log(`   ${ok ? "✅" : "❌"} ${step}${detail ? ` — ${detail}` : ""}`);
  return ok;
};

// ─── Probe ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  const nets = await spawnForks([configs.hydration]);
  const { hydration } = nets;
  try {
    const rpc = hydration.url.replace("ws://", "http://").replace("[::]", "127.0.0.1");
    const pub = createPublicClient({ transport: http(rpc) });
    const api = hydration.client.getUnsafeApi();
    const meta = (await (hydration.chain.head as never as { meta: Promise<any> }).meta) as any;
    const registry = (await (hydration.chain.head as never as { registry: Promise<any> }).registry) as any;

    const account = privateKeyToAccount(DEPLOYER_PK);
    const client = new EthClient(hydration, account, { chainId: HYDRATION_EVM_CHAIN_ID });
    const deployerSub = ss58(truncatedEvmAccount(account.address));
    const landingAcct = truncatedEvmAccount(LANDING);
    const landingSub = ss58(landingAcct);
    const treasurySub = ss58(TREASURY_ACCOUNT);
    const recipientSub = ss58(RECIPIENT);

    const tokenBalance = async (acct: string, assetId: number, at?: string): Promise<bigint> => {
      const v = (await retry(`Tokens.Accounts(${assetId})`, () =>
        api.query.Tokens.Accounts.getValue(acct, assetId, at ? { at } : {}),
      )) as { free?: bigint } | undefined;
      return v?.free ?? 0n;
    };
    const readLanding = <T>(fn: string, args: unknown[] = []) =>
      retry(fn, () =>
        pub.readContract({ address: LANDING, abi: LANDING_ABI, functionName: fn as never, args: args as never }),
      ) as Promise<T>;
    const readReceiver = <T>(receiver: Hex, fn: string, args: unknown[] = []) =>
      retry(fn, () =>
        pub.readContract({ address: receiver, abi: RECEIVER_ABI, functionName: fn as never, args: args as never }),
      ) as Promise<T>;
    const mmWithdrawable = () =>
      retry("balanceOf", () =>
        pub.readContract({ address: EURC_HYDRATION, abi: ERC20_ABI, functionName: "balanceOf", args: [AEURC_TOKEN] }),
      );
    const poolEurc = () =>
      retry("balanceOf", () =>
        pub.readContract({ address: EURC_HYDRATION, abi: ERC20_ABI, functionName: "balanceOf", args: [LANDING] }),
      );

    // Deployer: funded and whitelisted (EVMAccounts.ContractDeployer; mainnet needs a real slot).
    await hydration.setStorage({
      System: { Account: [[[deployerSub], { providers: 1, data: { free: 1_000_000n * 10n ** 12n } }]] },
      Tokens: { Accounts: [[[deployerSub, WETH_ASSET_ID], { free: 1_000n * 10n ** 18n }]] },
      EVMAccounts: { ContractDeployer: [[[account.address], true]] },
    });

    const head0 = (await retry("head", () => api.query.System.Number.getValue())) as number;
    console.log(`\n🥢 Basejump Base EURC go-live — fork of Hydration at block ${head0}`);
    console.log(`   landing   ${LANDING}`);
    console.log(`   admin     ${EMERGENCY_ADMIN}`);

    // ── 0. the Base receiver ──
    console.log(`\n── 0. Base receiver ──`);
    let receiver: Hex;
    let emitter: Hex;
    if (RECEIVER_OVERRIDE) {
      receiver = getAddress(RECEIVER_OVERRIDE);
      emitter = await readReceiver<Hex>(receiver, "authorizedEmitters", [BASE_WORMHOLE_ID]);
      console.log(`   live receiver ${receiver}`);
    } else {
      // Steps 005-008 of basejump-base, on the fork: impl, proxy + initialize(core), emitter for
      // chain 30, landing, owner → emergency admin.
      const impl = await client.deploy(artifact("BasejumpReceiver").bytecode.object);
      const init = encodeFunctionData({ abi: RECEIVER_ABI, functionName: "initialize", args: [MESSAGE_CORE] });
      const proxyCode = concatHex([
        artifact("ERC1967Proxy").bytecode.object,
        encodeAbiParameters([{ type: "address" }, { type: "bytes" }], [impl.address, init]),
      ]);
      const proxy = await client.deploy(proxyCode);
      receiver = proxy.address;
      emitter = pad(FORK_BASE_EMITTER, { size: 32 });
      const wire = [
        encodeFunctionData({ abi: RECEIVER_ABI, functionName: "setAuthorizedEmitter", args: [BASE_WORMHOLE_ID, emitter] }),
        encodeFunctionData({ abi: RECEIVER_ABI, functionName: "setLanding", args: [pad(LANDING, { size: 32 })] }),
        encodeFunctionData({ abi: RECEIVER_ABI, functionName: "setOwner", args: [EMERGENCY_ADMIN] }),
      ];
      for (const data of wire) {
        const res = await client.call(receiver, data);
        if (!evmSucceeded(await eventsAt(hydration, res.blockHash))) throw new Error("receiver wiring failed");
      }
      console.log(`   deployed on THIS FORK ${receiver} (impl ${impl.address})`);
    }
    const receiverCode = await retry("code", () => pub.getCode({ address: receiver }));
    record("receiver has code", !!receiverCode && receiverCode !== "0x", receiver);
    record(
      "receiver owned by the emergency admin",
      (await readReceiver<Hex>(receiver, "owner")).toLowerCase() === EMERGENCY_ADMIN.toLowerCase(),
    );
    record(
      "receiver points at the landing (invariant 1, Hydration side)",
      (await readReceiver<Hex>(receiver, "landing")).toLowerCase() === pad(LANDING, { size: 32 }).toLowerCase(),
    );
    record("receiver authorizes a chain-30 emitter", BigInt(emitter) !== 0n, emitter);

    // ── before ──
    const members = (await retry("TC members", () => api.query.TechnicalCommittee.Members.getValue())) as unknown[];
    const n = members.length;
    // TechCommitteeMajority = EnsureProportionAtLeast<1, 2>: yes · 2 ≥ n.
    const threshold = Math.ceil(n / 2);
    const before = {
      owner: await readLanding<Hex>("owner"),
      eurcRoute: await readLanding<Hex>("destAssetFor", [EURC_BASE]),
      usdcRoute: await readLanding<Hex>("destAssetFor", [USDC_ETHEREUM]),
      receiverAuthorized: await readLanding<boolean>("authorizedBridges", [receiver]),
      ethReceiverAuthorized: await readLanding<boolean>("authorizedBridges", [ETH_RECEIVER]),
      pendingHead: await readLanding<bigint>("pendingHead"),
      pendingTail: await readLanding<bigint>("pendingTail"),
      poolEurc: await poolEurc(),
      poolUsdc: await tokenBalance(landingSub, USDC_ASSET_ID),
      adminGas: await tokenBalance(ss58(EMERGENCY_ADMIN_EVM_ACCOUNT), WETH_ASSET_ID),
      treasuryEurc: await tokenBalance(treasurySub, EURC_ASSET_ID),
      treasuryUsdt: await tokenBalance(treasurySub, USDT_ASSET_ID),
    };
    console.log(`\n── Before ──`);
    console.log(`   landing owner        ${before.owner}`);
    console.log(`   Base EURC route      ${before.eurcRoute}`);
    console.log(`   Base receiver auth   ${before.receiverAuthorized}`);
    console.log(`   pool EURC / USDC     ${amt(before.poolEurc, "EURC")} / ${amt(before.poolUsdc, "USDC")}`);
    console.log(`   queue                ${before.pendingHead}/${before.pendingTail}`);
    console.log(`   admin gas            ${before.adminGas} wei WETH (ETH\\0-derived account)`);
    console.log(`   treasury EURC / USDT ${amt(before.treasuryEurc, "EURC")} / ${amt(before.treasuryUsdt, "USDT")}`);
    console.log(`   TC members           ${n} → majority threshold ${threshold}`);
    record("landing owned by the emergency admin", before.owner.toLowerCase() === EMERGENCY_ADMIN.toLowerCase());
    record("Base EURC not yet mapped", before.eurcRoute === ZERO, before.eurcRoute);
    record("Base receiver not yet authorized", before.receiverAuthorized === false);
    record("admin can pay EVM gas", before.adminGas > 0n);
    const shortfall = POOL_SEED > before.treasuryEurc ? POOL_SEED - before.treasuryEurc : 0n;
    const EURC_MIN_OUT = ((shortfall + BUY_STEP - 1n) / BUY_STEP) * BUY_STEP;
    const USDT_IN = (EURC_MIN_OUT * USDT_PER_EURC_X100) / 100n;
    const mmBefore = await mmWithdrawable();
    console.log(`   float                ${amt(POOL_SEED, "EURC")}  → sell ${amt(USDT_IN, "USDT")} for at least ${amt(EURC_MIN_OUT, "EURC")}`);
    console.log(`   money market EURC    ${amt(mmBefore, "EURC")} withdrawable`);
    record("treasury EURC + minimum bought covers the float", before.treasuryEurc + EURC_MIN_OUT >= POOL_SEED,
      `${amt(before.treasuryEurc + EURC_MIN_OUT, "EURC")} ≥ ${amt(POOL_SEED, "EURC")}`);

    // ── 1. the calldata ──
    const adminCall = (evmInput: Hex) =>
      meta.tx.dispatcher.dispatchAsEmergencyAdmin(
        meta.tx.evm.call(EMERGENCY_ADMIN, LANDING, evmInput, 0, GAS_LIMIT, MAX_FEE_PER_GAS, null, null, [], []),
      );
    const motionLegs = [
      {
        label: `landing.setDestAsset(Base EURC, asset 44)`,
        evmInput: encodeFunctionData({ abi: LANDING_ABI, functionName: "setDestAsset", args: [EURC_BASE, EURC_HYDRATION] }),
      },
      {
        label: `landing.setAuthorizedBridge(${receiver}, true)`,
        evmInput: encodeFunctionData({ abi: LANDING_ABI, functionName: "setAuthorizedBridge", args: [receiver, true] }),
      },
    ].map((l) => ({ ...l, call: adminCall(l.evmInput) }));
    const motion = meta.tx.utility.batchAll(motionLegs.map((l) => l.call));
    const motionBytes = motion.toU8a();
    const motionHash = registry.hash(motionBytes).toHex();
    const propose = meta.tx.technicalCommittee.propose(threshold, motion, motionBytes.length);

    const refLegs = [
      {
        label: `router.sell(USDT → EURC, ${amt(USDT_IN, "USDT")} in, at least ${amt(EURC_MIN_OUT, "EURC")} out)`,
        call: meta.tx.dispatcher.dispatchAsTreasury(
          meta.tx.router.sell(USDT_ASSET_ID, EURC_ASSET_ID, USDT_IN, EURC_MIN_OUT, USDT_TO_EURC_ROUTE),
        ),
      },
      {
        label: `currencies.transfer(landing ${landingSub}, EURC, ${amt(POOL_SEED, "EURC")})`,
        call: meta.tx.dispatcher.dispatchAsTreasury(meta.tx.currencies.transfer(landingAcct, EURC_ASSET_ID, POOL_SEED)),
      },
    ];
    const referendum = meta.tx.utility.batchAll(refLegs.map((l) => l.call));
    const refBytes = referendum.toU8a();
    const refHash = registry.hash(refBytes).toHex();

    console.log(`\n── 1. Calldata (built from the fork's own metadata; re-run before submitting) ──`);
    console.log(`\n   TREASURY REFERENDUM — Treasurer track`);
    for (const l of refLegs) console.log(`   · dispatcher.dispatchAsTreasury(${l.label})\n       call : ${l.call.toHex()}`);
    console.log(`   utility.batchAll(2)   ← the preimage to note`);
    console.log(`     len      : ${refBytes.length} bytes`);
    console.log(`     preimage : ${refHash}`);
    console.log(`     call     : ${referendum.toHex()}`);
    console.log(`\n   TC MOTION — EmergencyAdminOrigin (TC majority)`);
    for (const l of motionLegs) {
      console.log(`   · ${l.label}   (to = landing ${LANDING})`);
      console.log(`       evm input : ${l.evmInput}`);
      console.log(`       call      : ${l.call.toHex()}`);
    }
    console.log(`   utility.batchAll(2)`);
    console.log(`     len      : ${motionBytes.length} bytes`);
    console.log(`     hash     : ${motionHash}`);
    console.log(`     call     : ${motion.toHex()}`);
    console.log(`   technicalCommittee.propose(${threshold}, <batchAll>, ${motionBytes.length})   ← submit this`);
    console.log(`     call     : ${propose.toHex()}`);
    if (!RECEIVER_OVERRIDE) {
      console.log(`\n   NOTE: receiver ${receiver} exists on THIS FORK only. For mainnet, run`);
      console.log(`   pnpm migrate:basejump-base, re-run this probe with --receiver <005-deploy-receiver proxyAddress>,`);
      console.log(`   and submit that output.`);
    }

    // ── enact helper: preimage + agenda entry, one block, read the events ──
    const enact = async (label: string, call: any, origin: unknown): Promise<EventRecord[]> => {
      const bytes = call.toU8a();
      const hash = registry.hash(bytes).toHex();
      const len = bytes.length;
      await hydration.setStorage({ Preimage: { PreimageFor: [[[[hash, len]], boundedBytes(call.toHex())]] } });
      const stored = asBytes(await retry("PreimageFor", () => api.query.Preimage.PreimageFor.getValue([hash, len])))?.length ?? -1;
      if (stored !== len) throw new Error(`preimage for "${label}" stored ${stored} bytes, want ${len}`);
      const head = (await retry("head", () => api.query.System.Number.getValue())) as number;
      await hydration.setStorage({
        Scheduler: {
          Agenda: [[[head + 1], [{ call: { Lookup: { hash, len } }, origin, maybeId: null, priority: 0, maybePeriodic: null }]]],
        },
      });
      const { hash: block } = await (hydration.chain as unknown as { newBlock: () => Promise<{ hash: string }> }).newBlock();
      const evs = await eventsAt(hydration, block);
      const names = [...new Set(evs.map(evName))].filter((x) => !x.startsWith("System.Extrinsic") && !x.startsWith("RelayChainInfo"));
      console.log(`   events: ${names.join(" ")}`);
      if (!evs.some((e) => evName(e) === "Scheduler.Dispatched")) {
        logEvents(evs);
        throw new Error(`"${label}" never dispatched — origin shape or preimage problem, not the proposal`);
      }
      return evs;
    };

    // ── canary scaffolding: our guardian, a funded relayer, one VAA from the Base emitter ──
    const guardian = privateKeyToAccount(GUARDIAN_PK);
    await hydration.setStorage(guardianSetOverride(guardian.address));
    const vaa = await buildSignedVaa({ emitterChain: BASE_WORMHOLE_ID, emitter, sequence: 1n, payload: transferPayload(NET, 1n) });
    const vaaHash = keccak256(keccak256(`0x${vaa.slice(2 + 2 * (6 + 66))}` as Hex));
    const deliver = async (): Promise<{ ok: boolean; paid: bigint; debited: bigint; processed: boolean }> => {
      const poolBefore = await poolEurc();
      const recipBefore = await tokenBalance(recipientSub, EURC_ASSET_ID);
      const res = await client.call(
        receiver,
        encodeFunctionData({ abi: RECEIVER_ABI, functionName: "completeTransfer", args: [vaa] }),
      );
      const evs = await eventsAt(hydration, res.blockHash);
      const ok = evmSucceeded(evs);
      const recipAfter = await tokenBalance(recipientSub, EURC_ASSET_ID, res.blockHash);
      const poolAfter = await poolEurc();
      const processed = await readReceiver<boolean>(receiver, "processedVaas", [vaaHash]);
      console.log(`   completeTransfer ${ok ? "Succeed" : "Revert"}`);
      console.log(`   pool       ${amt(poolBefore, "EURC")} → ${amt(poolAfter, "EURC")}`);
      console.log(`   recipient  ${amt(recipBefore, "EURC")} → ${amt(recipAfter, "EURC")}`);
      return { ok, paid: recipAfter - recipBefore, debited: poolBefore - poolAfter, processed };
    };

    // ── 2. corridor dark ──
    console.log(`\n── 2. Canary before governance: ${amt(NET, "EURC")} net from the Base emitter ──`);
    const dark = await deliver();
    record("delivery reverts while the corridor is dark", !dark.ok && dark.paid === 0n && !dark.processed);

    // ── 3. referendum ──
    const refOrigin = ENACT_AS_ROOT ? { system: "Root" } : { Origins: "Treasurer" };
    console.log(`\n── 3. Enacting the treasury referendum from ${JSON.stringify(refOrigin)} ──`);
    const refEvents = await enact("referendum", referendum, refOrigin);
    const refInner = dispatchInnerResults(refEvents);
    record("both treasury legs dispatched Ok", refInner.length === 2 && refInner.every((r) => r.ok), toJson(refInner));
    record("batch completed", refEvents.some((e) => evName(e) === "Utility.BatchCompleted"));
    const treasuryUsdtAfter = await tokenBalance(treasurySub, USDT_ASSET_ID);
    const treasuryEurcAfter = await tokenBalance(treasurySub, EURC_ASSET_ID);
    const usdtSpent = before.treasuryUsdt - treasuryUsdtAfter;
    const eurcBought = treasuryEurcAfter + POOL_SEED - before.treasuryEurc;
    console.log(`   treasury USDT spent  ${amt(usdtSpent, "USDT")} for ${amt(eurcBought, "EURC")}  (${(Number(usdtSpent) / Number(eurcBought)).toFixed(4)} USDT per EURC)`);
    console.log(`   treasury EURC left   ${amt(treasuryEurcAfter, "EURC")}`);
    console.log(`   money market EURC    ${amt(mmBefore, "EURC")} → ${amt(await mmWithdrawable(), "EURC")} withdrawable`);
    record("treasury sold exactly the USDT in", usdtSpent === USDT_IN, amt(usdtSpent, "USDT"));
    record("treasury bought at least the EURC needed", eurcBought >= EURC_MIN_OUT, amt(eurcBought, "EURC"));
    const poolAfterSeed = await poolEurc();
    record("landing holds the float", poolAfterSeed === before.poolEurc + POOL_SEED, amt(poolAfterSeed, "EURC"));

    // ── 4. motion ──
    const motionOrigin = ENACT_AS_ROOT ? { system: "Root" } : { TechnicalCommittee: { Members: [threshold, n] } };
    console.log(`\n── 4. Enacting the TC motion from ${JSON.stringify(motionOrigin)} ──`);
    const motionEvents = await enact("motion", motion, motionOrigin);
    const motionInner = dispatchInnerResults(motionEvents);
    record("EmergencyAdminOrigin accepted both legs", motionInner.length === 2 && motionInner.every((r) => r.ok), toJson(motionInner));
    record(
      "both EVM calls executed",
      motionEvents.filter((e) => evName(e) === "EVM.Executed").length === 2,
    );
    const eurcRoute = await readLanding<Hex>("destAssetFor", [EURC_BASE]);
    record("destAssetFor(Base EURC) = asset 44", eurcRoute.toLowerCase() === EURC_HYDRATION.toLowerCase(), eurcRoute);
    record("Base receiver authorized", (await readLanding<boolean>("authorizedBridges", [receiver])) === true);
    record(
      "Ethereum corridor unchanged (USDC route, receiver)",
      (await readLanding<Hex>("destAssetFor", [USDC_ETHEREUM])).toLowerCase() === before.usdcRoute.toLowerCase() &&
        (await readLanding<boolean>("authorizedBridges", [ETH_RECEIVER])) === before.ethReceiverAuthorized,
    );
    record("pool USDC unchanged", (await tokenBalance(landingSub, USDC_ASSET_ID)) === before.poolUsdc);

    // ── 5. corridor open ──
    console.log(`\n── 5. Canary after governance: the same VAA ──`);
    const open = await deliver();
    record("delivery succeeds", open.ok && open.processed);
    record("recipient paid the net in EURC", open.paid === NET, amt(open.paid, "EURC"));
    record("pool debited the same", open.debited === NET);
    const pendingHead = await readLanding<bigint>("pendingHead");
    const pendingTail = await readLanding<bigint>("pendingTail");
    record("nothing queued", pendingHead === pendingTail, `${pendingHead}/${pendingTail}`);

    const failed = results.filter((r) => !r.ok);
    console.log(
      failed.length === 0
        ? `\n🥢 ✅ ${results.length}/${results.length} — the referendum funds the pool, the motion opens the route, and a Base EURC payout lands.`
        : `\n🥢 ❌ ${failed.length} failed: ${failed.map((f) => f.step).join("; ")}`,
    );
    if (failed.length) process.exitCode = 1;
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
