/**
 * PROBE (PSM go-live, Hydration): prints the bucket referendum and the two TC unpause motions,
 * enacts each on a fork of live Hydration under its real origin, then mints and redeems through
 * the real core with a swapped-in guardian key.
 *
 *   npx tsx chopsticks/probes/_probePsmGoLive.ts [--facilitator 0x…] [--vault 0x…] [--label "…"] [--no-canary]
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  BaseError,
  ContractFunctionRevertedError,
  concatHex,
  createPublicClient,
  decodeAbiParameters,
  decodeErrorResult,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  numberToHex,
  pad,
  parseAbi,
  toHex,
  type Abi,
  type Hex,
} from "viem";
import { privateKeyToAccount, sign } from "viem/accounts";
import { AccountId } from "polkadot-api";

import { configs } from "../lib/configs";
import { EthClient } from "../lib/eth";
import { logEvents, type EventRecord } from "../lib/events";
import { spawnForks, teardownForks, type Network } from "../lib/network";
import { getAccountCode } from "../lib/queries";
import { toJson } from "../lib/utils";

import facilitatorJson from "../../contracts/out/HollarBaseFacilitator.sol/HollarBaseFacilitator.json";
import proxyJson from "../../contracts/out/ERC1967Proxy.sol/ERC1967Proxy.psm.json";

// ─── Config ──────────────────────────────────────────────────────

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function readEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(\S*)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const ENV = readEnv(`${ROOT}migrations/envs/prod/psm-base.env`);
const env = (key: string): string => {
  if (!ENV[key]) throw new Error(`migrations/envs/prod/psm-base.env: missing ${key}`);
  return ENV[key];
};

type StepState = { name: string; status: string; output?: Record<string, string> };

function stateOutput(step: string): Record<string, string> | undefined {
  const path = `${ROOT}deployments/prod/psm-base.json`;
  if (!existsSync(path)) return undefined;
  const state = JSON.parse(readFileSync(path, "utf8")) as { steps?: StepState[] };
  return state.steps?.find((s) => s.name === step && s.status === "completed")?.output;
}

const arg = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : undefined;
};

const CORE = getAddress(env("WORMHOLE_CORE_HYDRATION"));
const HOLLAR = getAddress(env("HOLLAR_HYDRATION"));
const EVM_CHAIN_ID = Number(env("CHAIN_ID_HYDRATION"));
const BASE_CHAIN = Number(env("WORMHOLE_ID_BASE"));
const USDC_DECIMALS = Number(env("USDC_DECIMALS"));
const FACILITATOR_GUARDIAN = getAddress(env("FACILITATOR_GUARDIAN"));
const FACILITATOR_OWNER = getAddress(env("FACILITATOR_NEW_OWNER"));
const INBOUND_CAPACITY = BigInt(env("INBOUND_CAPACITY"));
const OUTBOUND_CAPACITY = BigInt(env("OUTBOUND_CAPACITY"));
const LIMIT_WINDOW = BigInt(env("LIMIT_WINDOW"));

const EMERGENCY_ADMIN = getAddress("0xaa7e0000000000000000000000000000000aa7e1");
const STAND_IN_VAULT = getAddress("0xba5e000000000000000000000000000000000001");

const LABEL = arg("--label") ?? "HOLLAR PSM Base USDC";
const BUCKET_CAPACITY = 10_000n * 10n ** 18n;

const MAX_FEE_PER_GAS = 10_000_000_000n;
const GAS_ADD_FACILITATOR = 300_000n;
const GAS_SET_PAUSED = 100_000n;
/** The track's 10-minute min_enactment_period at 6 s blocks. */
const ENACT_AFTER_BLOCKS = 100;

const WETH_ASSET_ID = 20;
const HYDRATION_SS58_PREFIX = 63;
const SCALE = 10n ** BigInt(18 - USDC_DECIMALS);

const RUN_CANARY = !process.argv.includes("--no-canary");

// anvil keys 0–2: stand-in deployer and relayer, swapped-in guardian, canary user
const DEPLOYER_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const GUARDIAN_PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const USER_PK = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as Hex;

const MINT_USDC = 100n * 10n ** 6n;
const REDEEM_USDC = 50n * 10n ** 6n;
const REDEEM_FEE_CAP = 5;
const CANARY_REF = `0x${"00".repeat(31)}01` as Hex;

const KIND_MINT = 1;
const KIND_REDEEM = 2;
const NO_FEE_CAP = 0xffff;

const DEFAULT_ADMIN_ROLE = pad("0x00", { size: 32 });
const GUARDIAN_ROLE = keccak256(toHex("GUARDIAN_ROLE"));
const FACILITATOR_MANAGER_ROLE = keccak256(toHex("FACILITATOR_MANAGER_ROLE"));

const FACILITATOR_ABI = facilitatorJson.abi as Abi;

const GHO_ABI = parseAbi([
  "function addFacilitator(address,string,uint128)",
  "function getFacilitator(address) view returns ((uint128 bucketCapacity, uint128 bucketLevel, string label))",
  "function getFacilitatorBucket(address) view returns (uint256, uint256)",
  "function hasRole(bytes32,address) view returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);

const CORE_ABI = parseAbi([
  "function getCurrentGuardianSetIndex() view returns (uint32)",
  "function getGuardianSet(uint32) view returns ((address[] keys, uint32 expirationTime))",
]);

// ─── Helpers ─────────────────────────────────────────────────────

type Origin =
  | { Origins: "EconomicParameters" }
  | { TechnicalCommittee: { Members: [number, number] } };

/** `dev_setStorage` writes a 0x string verbatim, so the BoundedVec length prefix is ours to add. */
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

/** The account pallet_evm debits for an unbound H160: b"ETH\0" ++ h160 ++ [0u8;8]. */
const truncatedEvmAccount = (h160: Hex): Hex =>
  `0x45544800${h160.slice(2).toLowerCase()}${"00".repeat(8)}` as Hex;

const ss58 = (pubkey: Hex): string => AccountId(HYDRATION_SS58_PREFIX).dec(pubkey);

const bytesHex = (b: Uint8Array): Hex => `0x${Buffer.from(b).toString("hex")}` as Hex;

/** papi hands bytes back as Uint8Array, a Binary, or already-hex depending on the codec. */
function anyHex(raw: unknown): Hex {
  if (typeof raw === "string") return raw as Hex;
  if (raw instanceof Uint8Array) return bytesHex(raw);
  const asHex = (raw as { asHex?: () => string })?.asHex;
  if (typeof asHex === "function") return asHex.call(raw) as Hex;
  throw new Error(`unrecognised bytes shape: ${Object.prototype.toString.call(raw)}`);
}

function asBytes(v: unknown): Uint8Array | undefined {
  if (v instanceof Uint8Array) return v;
  const b = (v as { asBytes?: () => Uint8Array } | undefined)?.asBytes?.();
  return b instanceof Uint8Array ? b : undefined;
}

const weth = (v: bigint): string => `${(Number(v) / 1e18).toFixed(6)} WETH`;
const hollar = (v: bigint): string => `${(Number(v) / 1e18).toLocaleString()} HOLLAR`;
const usdc = (v: bigint): string => `${(Number(v) / 10 ** USDC_DECIMALS).toLocaleString()} USDC`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

/** dispatch_as_* returns Ok whatever the inner call did; the inner result is only in its event. */
function dispatchInner(events: EventRecord[]): { ok: boolean; err: string | null } | null {
  for (const { event } of events) {
    const e = event as {
      type: string;
      value: { type: string; value?: { result?: { value?: { error?: unknown } } } };
    };
    if (e.type === "Dispatcher" && e.value?.type?.endsWith("CallDispatched")) {
      const err = e.value.value?.result?.value?.error;
      return err === undefined ? { ok: true, err: null } : { ok: false, err: toJson(err) };
    }
  }
  return null;
}

/** pallet_ethereum always emits Executed and carries the outcome in exit_reason. */
function ethSucceeded(events: EventRecord[]): boolean {
  return events.some(({ event }) => {
    const ev = event as { type: string; value: { type: string; value?: { exit_reason?: { type?: string } } } };
    return ev.type === "Ethereum" && ev.value?.type === "Executed" && ev.value.value?.exit_reason?.type === "Succeed";
  });
}

interface EvmLog {
  address: string;
  topics: string[];
  data: unknown;
}

const evmLogs = (events: EventRecord[]): EvmLog[] =>
  events
    .map((e) => e.event as { type: string; value: { type: string; value?: { log?: EvmLog } } })
    .filter((e) => e.type === "EVM" && e.value.type === "Log")
    .map((e) => e.value.value?.log)
    .filter((l): l is EvmLog => Boolean(l));

/** The 100-byte PSM body: version | kind | recipient | amount | origin | maxFeeBps. */
const psmPayload = (kind: number, recipient: Hex, amount: bigint, origin: Hex, maxFeeBps = NO_FEE_CAP): Hex =>
  concatHex([
    "0x01",
    pad(numberToHex(kind), { size: 1 }),
    pad(recipient, { size: 32 }),
    pad(numberToHex(amount), { size: 32 }),
    pad(origin, { size: 32 }),
    pad(numberToHex(maxFeeBps), { size: 2 }),
  ]);

const slotHex = (n: bigint): Hex => pad(numberToHex(n), { size: 32 });

/** guardianSets is the core's slot 2: keys length at the struct base, key data at keccak(base). */
function guardianSetOverride(index: number, guardian: Hex): Record<string, unknown> {
  const base = BigInt(
    keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [BigInt(index), 2n])),
  );
  const keysData = BigInt(keccak256(slotHex(base)));
  return {
    EVM: {
      AccountStorages: [
        [[CORE, slotHex(base)], slotHex(1n)],
        [[CORE, slotHex(keysData)], pad(guardian, { size: 32 })],
      ],
    },
  };
}

async function signedVaa(opts: {
  guardianSetIndex: number;
  emitterChain: number;
  emitter: Hex;
  sequence: bigint;
  consistency: number;
  payload: Hex;
}): Promise<Hex> {
  const body = concatHex([
    pad(numberToHex(Math.floor(Date.now() / 1000)), { size: 4 }),
    pad(numberToHex(0), { size: 4 }),
    pad(numberToHex(opts.emitterChain), { size: 2 }),
    pad(opts.emitter, { size: 32 }),
    pad(numberToHex(opts.sequence), { size: 8 }),
    pad(numberToHex(opts.consistency), { size: 1 }),
    opts.payload,
  ]);
  const { r, s, v } = await sign({ hash: keccak256(keccak256(body)), privateKey: GUARDIAN_PK });
  return concatHex([
    pad(numberToHex(1), { size: 1 }),
    pad(numberToHex(opts.guardianSetIndex), { size: 4 }),
    pad(numberToHex(1), { size: 1 }),
    pad(numberToHex(0), { size: 1 }),
    pad(r, { size: 32 }),
    pad(s, { size: 32 }),
    pad(numberToHex(Number(v! - 27n)), { size: 1 }),
    body,
  ]);
}

const results: { check: string; ok: boolean }[] = [];
const record = (check: string, ok: boolean, detail = ""): boolean => {
  results.push({ check, ok });
  console.log(`   ${ok ? "✅" : "❌"} ${check}${detail ? ` — ${detail}` : ""}`);
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

    const read = <T>(address: Hex, abi: Abi, functionName: string, args: unknown[] = []): Promise<T> =>
      retry(functionName, () => pub.readContract({ address, abi, functionName, args } as never)) as Promise<T>;
    const wethOf = async (h160: Hex): Promise<bigint> => {
      const v = (await retry("Tokens.Accounts", () =>
        api.query.Tokens.Accounts.getValue(ss58(truncatedEvmAccount(h160)), WETH_ASSET_ID),
      )) as { free?: bigint } | undefined;
      return v?.free ?? 0n;
    };
    const fund = (h160: Hex) => {
      const sub = ss58(truncatedEvmAccount(h160));
      return hydration.setStorage({
        System: { Account: [[[sub], { providers: 1, data: { free: 1_000_000n * 10n ** 12n } }]] },
        Tokens: { Accounts: [[[sub, WETH_ASSET_ID], { free: 100n * 10n ** 18n }]] },
      });
    };
    const assertTx = async (label: string, res: { blockHash: string }): Promise<EventRecord[]> => {
      const evs = await eventsAt(hydration, res.blockHash);
      if (!ethSucceeded(evs)) {
        logEvents(evs);
        throw new Error(`${label}: EVM call did not succeed`);
      }
      return evs;
    };

    // ── live authorities ──
    const aaveManagerAccount = (await retry("Dispatcher.AaveManagerAccount", () =>
      api.query.Dispatcher.AaveManagerAccount.getValue(),
    )) as string;
    const AAVE_MANAGER = getAddress(bytesHex(AccountId().enc(aaveManagerAccount).slice(0, 20)));
    const members = (await retry("TechnicalCommittee.Members", () =>
      api.query.TechnicalCommittee.Members.getValue(),
    )) as string[];
    const total = members.length;
    const threshold = Math.ceil(total / 2);
    const guardianSetIndex = await read<number>(CORE, CORE_ABI, "getCurrentGuardianSetIndex");

    // ── the facilitator: deployed, or a stand-in at 004–007's end state ──
    const deployedOut = stateOutput("004-deploy-facilitator");
    let facilitator = (arg("--facilitator") ?? deployedOut?.proxyAddress) as Hex | undefined;
    const vault = getAddress((arg("--vault") ?? stateOutput("001-deploy-vault")?.proxyAddress ?? STAND_IN_VAULT) as Hex);
    const standIn = !facilitator;
    const deployer = privateKeyToAccount(DEPLOYER_PK);
    let deployerOfRecord = deployedOut?.ownerAddress as Hex | undefined;

    await fund(deployer.address);
    // One client per key: EthClient counts nonces locally from 0.
    const deployerClient = new EthClient(hydration, deployer, { chainId: EVM_CHAIN_ID, gas: 13_000_000n });

    if (standIn) {
      console.log(`\n── Stand-in facilitator (no psm-base 004 output) ──`);
      await hydration.setStorage({ EVMAccounts: { ContractDeployer: [[[deployer.address], {}]] } });
      const deploy = async (label: string, initCode: Hex): Promise<Hex> => {
        const { address, res } = await deployerClient.deploy(initCode);
        const size = ((await getAccountCode(hydration, address, res.blockHash)).length - 2) / 2;
        console.log(`   ${label.padEnd(18)} ${address}  (${size} bytes)`);
        if (size === 0) throw new Error(`${label} deployed no code`);
        return address;
      };
      const impl = await deploy("impl", facilitatorJson.bytecode.object as Hex);
      const init = encodeFunctionData({
        abi: FACILITATOR_ABI,
        functionName: "initializeFacilitator",
        args: [CORE, HOLLAR, USDC_DECIMALS, BASE_CHAIN, deployer.address, FACILITATOR_GUARDIAN],
      });
      facilitator = await deploy(
        "proxy",
        concatHex([proxyJson.bytecode.object as Hex, encodeAbiParameters([{ type: "address" }, { type: "bytes" }], [impl, init])]),
      );
      const call = async (label: string, functionName: string, args: unknown[]) =>
        assertTx(label, await deployerClient.call(facilitator!, encodeFunctionData({ abi: FACILITATOR_ABI, functionName, args } as never)));
      await call("005 setBaseEmitter", "setBaseEmitter", [pad(vault, { size: 32 })]);
      await call("006 setLimits", "setLimits", [INBOUND_CAPACITY, OUTBOUND_CAPACITY, LIMIT_WINDOW]);
      await call("007 grantRole", "grantRole", [DEFAULT_ADMIN_ROLE, FACILITATOR_OWNER]);
      await call("007 renounceRole", "renounceRole", [DEFAULT_ADMIN_ROLE, deployer.address]);
      deployerOfRecord = deployer.address;
      console.log(`   wired as 005–007 leave it, vault ${vault}`);
    }
    const FAC = getAddress(facilitator!);

    // ── pre-state ──
    console.log(`\n── Before ──`);
    console.log(`   facilitator      ${FAC}${standIn ? "  (STAND-IN)" : ""}`);
    console.log(`   aave manager     ${AAVE_MANAGER}  (Dispatcher.AaveManagerAccount)`);
    console.log(`   emergency admin  ${EMERGENCY_ADMIN}`);
    console.log(`   tech committee   ${threshold}/${total}`);
    console.log(`   guardian set     ${guardianSetIndex}`);

    const code = await retry("code", () => pub.getCode({ address: FAC }));
    record("facilitator has code", !!code && code !== "0x");
    record("hollar() is HOLLAR", getAddress(await read<Hex>(FAC, FACILITATOR_ABI, "hollar")) === HOLLAR);
    record("baseChainId() is Base", (await read<number>(FAC, FACILITATOR_ABI, "baseChainId")) === BASE_CHAIN);
    const boundEmitter = await read<Hex>(FAC, FACILITATOR_ABI, "authorizedEmitters", [BASE_CHAIN]);
    record("emitter bound", (await read<boolean>(FAC, FACILITATOR_ABI, "emitterFrozen")) && BigInt(boundEmitter) !== 0n, boundEmitter);
    if (arg("--vault") || stateOutput("001-deploy-vault") || standIn) {
      record("bound emitter is the vault", boundEmitter.toLowerCase() === pad(vault, { size: 32 }).toLowerCase(), vault);
    }
    const [inCap, , outCap] = await read<[bigint, bigint, bigint, bigint]>(FAC, FACILITATOR_ABI, "limits");
    record("limits are the env's", inCap === INBOUND_CAPACITY && outCap === OUTBOUND_CAPACITY, `${usdc(inCap)} / ${usdc(outCap)}`);
    record("mint paused", await read<boolean>(FAC, FACILITATOR_ABI, "mintPaused"));
    record("redeem paused", await read<boolean>(FAC, FACILITATOR_ABI, "redeemPaused"));
    record("admin is the TC account", await read<boolean>(FAC, FACILITATOR_ABI, "hasRole", [DEFAULT_ADMIN_ROLE, FACILITATOR_OWNER]));
    if (deployerOfRecord) {
      record("deployer holds no admin", !(await read<boolean>(FAC, FACILITATOR_ABI, "hasRole", [DEFAULT_ADMIN_ROLE, deployerOfRecord])));
    }
    record(
      "guardian is the emergency admin",
      FACILITATOR_GUARDIAN === EMERGENCY_ADMIN &&
        (await read<boolean>(FAC, FACILITATOR_ABI, "hasRole", [GUARDIAN_ROLE, EMERGENCY_ADMIN])),
    );
    record(
      "aave manager holds FACILITATOR_MANAGER_ROLE",
      await read<boolean>(HOLLAR, GHO_ABI, "hasRole", [FACILITATOR_MANAGER_ROLE, AAVE_MANAGER]),
    );
    const existing = await read<{ label: string }>(HOLLAR, GHO_ABI, "getFacilitator", [FAC]);
    record("not yet a GHO facilitator", existing.label === "", existing.label);

    const reserveAdd = GAS_ADD_FACILITATOR * MAX_FEE_PER_GAS;
    const reservePause = GAS_SET_PAUSED * MAX_FEE_PER_GAS;
    const managerGas = await wethOf(AAVE_MANAGER);
    const adminGas = await wethOf(EMERGENCY_ADMIN);
    record("aave manager gas covers the reserve", managerGas >= reserveAdd, `${weth(managerGas)} ≥ ${weth(reserveAdd)}`);
    record("emergency admin gas covers the reserve", adminGas >= reservePause, `${weth(adminGas)} ≥ ${weth(reservePause)}`);

    // ── the calls ──
    const evmCall = (source: Hex, target: Hex, input: Hex, gas: bigint) =>
      meta.tx.evm.call(source, target, input, 0, gas, MAX_FEE_PER_GAS, null, null, [], []);
    const addInput = encodeFunctionData({ abi: GHO_ABI, functionName: "addFacilitator", args: [FAC, LABEL, BUCKET_CAPACITY] });
    const referendum = meta.tx.dispatcher.dispatchAsAaveManager(evmCall(AAVE_MANAGER, HOLLAR, addInput, GAS_ADD_FACILITATOR));
    const pauseInput = (mint: boolean, redeem: boolean) =>
      encodeFunctionData({ abi: FACILITATOR_ABI, functionName: "setPaused", args: [mint, redeem] });
    const motion = (mint: boolean, redeem: boolean) =>
      meta.tx.dispatcher.dispatchAsEmergencyAdmin(evmCall(EMERGENCY_ADMIN, FAC, pauseInput(mint, redeem), GAS_SET_PAUSED));
    const openRedeem = motion(true, false);
    const openMint = motion(false, false);

    const refBytes = referendum.toU8a();
    const refHash = registry.hash(refBytes).toHex();
    const origin: Origin = { Origins: "EconomicParameters" };
    const notePreimage = meta.tx.preimage.notePreimage(referendum.toHex());
    const submit = meta.tx.referenda.submit(origin, { Lookup: { hash: refHash, len: refBytes.length } }, { After: ENACT_AFTER_BLOCKS });

    console.log(`\n── Calldata ──`);
    if (standIn) {
      console.log(`\n   ⚠ STAND-IN facilitator — NOT SUBMITTABLE. Every call below names ${FAC}.`);
      console.log(`     Re-run after psm-base 004 has written deployments/prod/psm-base.json.`);
    }
    console.log(`\n   Referendum — track economic_parameters (750,000 HDX decision deposit, 7 d decision, 12 h confirm)`);
    console.log(`     addFacilitator(${FAC}, "${LABEL}", ${hollar(BUCKET_CAPACITY)})`);
    console.log(`     evm input            : ${addInput}`);
    console.log(`     call (${refBytes.length} bytes)     : ${referendum.toHex()}`);
    console.log(`     preimage hash        : ${refHash}`);
    console.log(`     1 preimage.notePreimage : ${notePreimage.toHex()}`);
    console.log(`     2 referenda.submit      : ${submit.toHex()}`);
    console.log(`       (Origins.EconomicParameters, Lookup, After ${ENACT_AFTER_BLOCKS})`);
    for (const [label, call] of [
      ["Motion 1 — open redeem: setPaused(true, false)", openRedeem],
      ["Motion 2 — open mint, once the bucket is granted: setPaused(false, false)", openMint],
    ] as const) {
      const bytes = call.toU8a();
      console.log(`\n   ${label}`);
      console.log(`     call (${bytes.length} bytes)     : ${call.toHex()}`);
      console.log(`     hash                 : ${registry.hash(bytes).toHex()}`);
      console.log(`     technicalCommittee.propose(${threshold}, call, ${bytes.length}) : ${meta.tx.technicalCommittee.propose(threshold, call, bytes.length).toHex()}`);
    }
    console.log(`\n   Gas — held by the ETH\\0 accounts pallet_evm debits, not spent by governance`);
    console.log(`     aave manager     ${ss58(truncatedEvmAccount(AAVE_MANAGER))}  ${weth(managerGas)}, needs ${weth(reserveAdd)}`);
    console.log(`     emergency admin  ${ss58(truncatedEvmAccount(EMERGENCY_ADMIN))}  ${weth(adminGas)}, needs ${weth(reservePause)}`);

    // ── enactment ──
    const enact = async (label: string, call: any, by: Origin): Promise<EventRecord[]> => {
      const head = (await retry("head", () => api.query.System.Number.getValue())) as number;
      const bytes = call.toU8a();
      const callHash = registry.hash(bytes).toHex();
      const len = bytes.length;
      await hydration.setStorage({ Preimage: { PreimageFor: [[[[callHash, len]], boundedBytes(call.toHex())]] } });
      const stored = await retry("PreimageFor", () => api.query.Preimage.PreimageFor.getValue([callHash, len]));
      if ((asBytes(stored)?.length ?? -1) !== len) throw new Error(`${label}: preimage did not store ${len} bytes`);
      await hydration.setStorage({
        Scheduler: {
          Agenda: [[[head + 1], [{ call: { Lookup: { hash: callHash, len } }, origin: by, maybeId: null, priority: 0, maybePeriodic: null }]]],
        },
      });
      // In-process: dev_newBlock never returns on a heavy block.
      const { hash } = await (hydration.chain as unknown as { newBlock: () => Promise<{ hash: string }> }).newBlock();
      const evs = await eventsAt(hydration, hash);
      const inner = dispatchInner(evs);
      console.log(
        `   · ${label}: dispatcher=${inner === null ? "n/a" : inner.ok ? "Ok" : `Err ${inner.err}`}  ` +
          `[${[...new Set(evs.map(evName))].filter((n) => !n.startsWith("System.Extrinsic") && !n.startsWith("RelayChainInfo")).join(" ")}]`,
      );
      if (!evs.some((e) => evName(e) === "Scheduler.Dispatched")) {
        throw new Error(`${label}: the scheduler never dispatched it — check the origin shape ${toJson(by)}`);
      }
      record(`${label}: inner call Ok`, inner?.ok === true, inner?.err ?? "");
      record(`${label}: EVM executed`, evs.some((e) => evName(e) === "EVM.Executed"));
      if (evs.some((e) => evName(e) === "EVM.ExecutedFailed")) logEvents(evs);
      return evs;
    };
    const tc: Origin = { TechnicalCommittee: { Members: [threshold, total] } };
    const baseFee = await retry("gasPrice", () => pub.getGasPrice());
    const spent = (before: bigint, after: bigint) =>
      `${weth(before - after)}${baseFee > 0n ? ` ≈ ${(before - after) / baseFee} gas` : ""}`;

    console.log(`\n── Referendum, enacted as Origins.EconomicParameters ──`);
    await enact("addFacilitator", referendum, origin);
    const f = await read<{ bucketCapacity: bigint; bucketLevel: bigint; label: string }>(HOLLAR, GHO_ABI, "getFacilitator", [FAC]);
    record("bucket granted", f.bucketCapacity === BUCKET_CAPACITY && f.bucketLevel === 0n, `${hollar(f.bucketCapacity)}, level ${hollar(f.bucketLevel)}`);
    record("label", f.label === LABEL, f.label);
    record("mintHeadroom 0 while mint paused", (await read<bigint>(FAC, FACILITATOR_ABI, "mintHeadroom")) === 0n);
    const managerAfter = await wethOf(AAVE_MANAGER);
    console.log(`   aave manager spent ${spent(managerGas, managerAfter)} of ${GAS_ADD_FACILITATOR} limit`);

    console.log(`\n── Motion 1, enacted as TechnicalCommittee ${threshold}/${total} ──`);
    await enact("open redeem", openRedeem, tc);
    record("redeem open, mint still paused",
      !(await read<boolean>(FAC, FACILITATOR_ABI, "redeemPaused")) && (await read<boolean>(FAC, FACILITATOR_ABI, "mintPaused")));
    record("maxRedeemable 0 — no capacity before the first mint", (await read<bigint>(FAC, FACILITATOR_ABI, "maxRedeemable")) === 0n);

    const user = privateKeyToAccount(USER_PK);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60);
    const revertName = async (args: unknown[]): Promise<string> => {
      try {
        await pub.simulateContract({ account: user.address, address: FAC, abi: FACILITATOR_ABI, functionName: "redeem", args } as never);
        return "no revert";
      } catch (e) {
        const r = (e as BaseError).walk?.((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
        if (r?.data?.errorName) return r.data.errorName;
        // chopsticks returns custom errors as reason text, not revert data
        const raw = String((e as Error).message).match(/0x[0-9a-fA-F]{8,}/)?.[0] as Hex | undefined;
        if (raw) {
          try {
            return decodeErrorResult({ abi: FACILITATOR_ABI, data: raw }).errorName;
          } catch {}
        }
        return r?.reason ?? (e as BaseError).shortMessage ?? String(e);
      }
    };
    const preMint = await revertName([1n, user.address, REDEEM_FEE_CAP, deadline, CANARY_REF]);
    record("redeem before any mint reverts ExceedsBucketLevel", preMint === "ExceedsBucketLevel", preMint);

    console.log(`\n── Motion 2, enacted as TechnicalCommittee ${threshold}/${total} ──`);
    await enact("open mint", openMint, tc);
    record("mint open", !(await read<boolean>(FAC, FACILITATOR_ABI, "mintPaused")));
    const headroom = await read<bigint>(FAC, FACILITATOR_ABI, "mintHeadroom");
    const expectHeadroom = BUCKET_CAPACITY / SCALE < INBOUND_CAPACITY ? BUCKET_CAPACITY / SCALE : INBOUND_CAPACITY;
    record("mintHeadroom is the bucket or the inbound limit", headroom === expectHeadroom, usdc(headroom));
    const adminAfter = await wethOf(EMERGENCY_ADMIN);
    console.log(`   emergency admin spent ${spent(adminGas, adminAfter)} over both motions, ${GAS_SET_PAUSED} limit each`);

    // ── canary: a deposit's VAA through the real core, then a redeem ──
    if (RUN_CANARY) {
      console.log(`\n── Canary (guardian set ${guardianSetIndex} swapped for one key we hold) ──`);
      const guardian = privateKeyToAccount(GUARDIAN_PK);
      await hydration.setStorage(guardianSetOverride(guardianSetIndex, guardian.address));
      const set = await read<{ keys: Hex[] }>(CORE, CORE_ABI, "getGuardianSet", [guardianSetIndex]);
      record("guardian set swapped", set.keys.length === 1 && getAddress(set.keys[0]) === guardian.address);

      await fund(user.address);
      const vaa = await signedVaa({
        guardianSetIndex,
        emitterChain: BASE_CHAIN,
        emitter: boundEmitter,
        sequence: 1n,
        consistency: 200,
        payload: psmPayload(KIND_MINT, user.address, MINT_USDC, user.address),
      });
      const relayer = deployerClient;
      const balance = () => read<bigint>(HOLLAR, GHO_ABI, "balanceOf", [user.address]);
      const level = async () => (await read<[bigint, bigint]>(HOLLAR, GHO_ABI, "getFacilitatorBucket", [FAC]))[1];

      const before = await balance();
      await assertTx("receiveMessage (mint)", await relayer.call(FAC, encodeFunctionData({ abi: FACILITATOR_ABI, functionName: "receiveMessage", args: [vaa] })));
      record("mint delivered through the real core", (await balance()) - before === MINT_USDC * SCALE, hollar(MINT_USDC * SCALE));
      record("bucket level tracks the mint", (await level()) === MINT_USDC * SCALE, hollar(await level()));

      const userClient = new EthClient(hydration, user, { chainId: EVM_CHAIN_ID });
      await assertTx("approve", await userClient.call(HOLLAR, encodeFunctionData({ abi: GHO_ABI, functionName: "approve", args: [FAC, MINT_USDC * SCALE] })));
      const res = await userClient.call(
        FAC,
        encodeFunctionData({ abi: FACILITATOR_ABI, functionName: "redeem", args: [REDEEM_USDC, user.address, REDEEM_FEE_CAP, deadline, CANARY_REF] }),
      );
      const evs = await assertTx("redeem", res);
      record("redeem burned", (await level()) === (MINT_USDC - REDEEM_USDC) * SCALE, `level ${hollar(await level())}`);
      record("maxRedeemable is what this facilitator minted, net", (await read<bigint>(FAC, FACILITATOR_ABI, "maxRedeemable")) === MINT_USDC - REDEEM_USDC);

      const published = evmLogs(evs).find(
        (l) =>
          anyHex(l.address).toLowerCase() === CORE.toLowerCase() &&
          l.topics.length > 1 &&
          anyHex(l.topics[1]).toLowerCase() === pad(FAC, { size: 32 }).toLowerCase(),
      );
      if (record("redeem published on the core", !!published)) {
        const [, , payload, consistency] = decodeAbiParameters(
          [{ type: "uint64" }, { type: "uint32" }, { type: "bytes" }, { type: "uint8" }],
          anyHex(published!.data),
        );
        const body = payload as Hex;
        const kind = parseInt(body.slice(4, 6), 16);
        const originOut = getAddress(`0x${body.slice(2 + 66 * 2 + 24, 2 + 98 * 2)}`);
        const cap = parseInt(body.slice(2 + 98 * 2), 16);
        record("finalized, 100-byte KIND_REDEEM", consistency === 1 && (body.length - 2) / 2 === 100 && kind === KIND_REDEEM, `consistency ${consistency}, kind ${kind}`);
        record("origin and fee cap on the wire", originOut === user.address && cap === REDEEM_FEE_CAP, `${originOut}, ${cap} bps`);
      }
    }

    const failed = results.filter((r) => !r.ok);
    console.log(
      failed.length === 0
        ? `\n🥢 ✅ ${results.length}/${results.length} — referendum and both motions enact${RUN_CANARY ? ", mint and redeem run" : ""}.` +
            (standIn ? `\n   Stand-in facilitator: re-run after psm-base 004 for the calldata to submit.` : "")
        : `\n🥢 ❌ ${failed.length}/${results.length} failed: ${failed.map((r) => r.check).join(", ")}`,
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
