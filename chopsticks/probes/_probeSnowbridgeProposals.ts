/**
 * Build the Snowbridge switch and transfer proposals and rehearse them on Hydration + Asset Hub + Bridge Hub forks.
 *
 *   npx tsx probes/_probeSnowbridgeProposals.ts [--stage both|switch|transfer] [--final]
 *     [--spokes <id→address json>] [--hubs <id→address json>] [--eth-funder <0x…>] [--converter <0x…>]
 *     [--converter-owner <0x…>] [--ether-fee <wei>] [--dot-withdraw <planck>] [--dot-fee <planck>]
 *     [--fee-margin <x>] [--restore-after <blocks>]
 *
 * `both` (default) rehearses the switch, then a transfer built from the forked post-switch state; neither
 * output is submittable. `--stage switch --final` before the switch, and `--stage transfer --final` once
 * the switch has enacted on mainnet, write the submittable proposals and refuse placeholders, a
 * fork-deployed converter and any failed check.
 */
import { readFileSync, writeFileSync } from "node:fs";

import { AccountId, Binary } from "polkadot-api";
import {
  createPublicClient,
  encodeDeployData,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  http,
  isAddress,
  pad,
  parseAbi,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { forgeArtifact } from "@whm/common/evm/artifacts";

import { EthClient, type EthTxResult } from "../lib/eth";
import { spawnForks, teardownForks, type Network } from "../lib/network";
import { getAccountCode } from "../lib/queries";
import { toJson } from "../lib/utils";

import {
  FORK_SPECS,
  arg,
  checklist,
  dispatchAs,
  dispatchOk,
  enactWhitelisted,
  eventsAt,
  finalize,
  flag,
  pick,
  summarize,
  type Check,
} from "./snowbridgeFork";
import {
  APYUSD_ID,
  ASSET_HUB_PARA_ID,
  DEFAULT_FEES,
  DEPOSIT_PERIOD,
  DOT_LOCATION,
  EMERGENCY_ADMIN,
  ETHER_LOCATION,
  FUSE_RESTORE_AFTER,
  HYDRATION_SA_ON_ASSET_HUB,
  SNOWBRIDGE_ASSETS,
  TWIN_HUBS,
  WETH_ETHEREUM,
  buildExitXcm,
  callName,
  decodeCall,
  encodeRetireLocation,
  encodeScheduleAfter,
  encodeSendToAssetHub,
  encodeSetAssetCategoryExternal,
  encodeSetNttMinter,
  encodeSetXcmRateLimit,
  encodeUpdateBalance,
  encodeWhLocation,
  exitTopic,
  isPlaceholder,
  placeholderFunder,
  placeholderHub,
  placeholderSpoke,
  precompile,
  sameValue,
  switchedLocationShape,
  tokenLocation,
  truncatedEvmAccount,
  type Call,
  type SnowbridgeAsset,
} from "./snowbridgeExit";

const EVM_CHAIN_ID = 222222;
const WETH_ID = 20;
const TBTC_ID = 1000765;
const USDC_SB_ID = 1000766;
const USDT_AH = 1984;
const USDC_AH = 1337;
const WORMHOLE_HYDRATION = 73;
const NTT_LOCKING = 0;
const NTT_BURNING = 1;
// anvil keys, fork only
const DEPLOYER_PK: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const USER_PK: Hex = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const ERC1967_IMPL_SLOT: Hex = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

const ETH_RPC = process.env.RPC_ETHEREUM ?? "https://ethereum-rpc.publicnode.com";
const NTT_ABI = parseAbi([
  "function token() view returns (address)",
  "function getMode() view returns (uint8)",
  "function getPeer(uint16) view returns ((bytes32 peerAddress, uint8 tokenDecimals))",
]);
const FUNDER_ABI = parseAbi(["function weth() view returns (address)", "function hub() view returns (address)"]);

const KSM_LOCATION = {
  parents: 2,
  interior: { type: "X1", value: { type: "GlobalConsensus", value: { type: "Kusama", value: undefined } } },
};
const MYTH_LOCATION = { parents: 1, interior: { type: "X1", value: { type: "Parachain", value: 3369 } } };

const CONVERTER = forgeArtifact("SnowbridgeConverter");
const PROXY = forgeArtifact("ERC1967Proxy");
const CONVERTER_RUNTIME = (
  CONVERTER as unknown as {
    deployedBytecode: { object: Hex; immutableReferences?: Record<string, { start: number; length: number }[]> };
  }
).deployedBytecode;

const hdxAccount = (pubkey: Hex) => AccountId(63).dec(Binary.fromHex(pubkey));
const ahAccount = (pubkey: Hex) => AccountId(0).dec(Binary.fromHex(pubkey));
const modl = (id: string): Hex => `0x${Buffer.from(`modl${id}`).toString("hex").padEnd(64, "0")}`;
const dot = (planck: bigint | undefined) => (planck === undefined ? "?" : (Number(planck) / 1e10).toFixed(4));

interface Row extends SnowbridgeAsset {
  issuance: bigint;
}

function addressArg(name: string): Hex | undefined {
  if (!process.argv.includes(`--${name}`)) return undefined;
  const v = arg(name);
  if (v === undefined || !isAddress(v)) throw new Error(`--${name} ${JSON.stringify(v)} is not an address`);
  return getAddress(v);
}

function addressMap(name: string, allowed: Set<number>): Record<number, Hex> {
  if (!process.argv.includes(`--${name}`)) return {};
  const file = arg(name);
  if (!file) throw new Error(`--${name} needs a file`);
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
  const out: Record<number, Hex> = {};
  for (const [id, a] of Object.entries(raw)) {
    if (!allowed.has(Number(id))) throw new Error(`--${name} ${file}: ${id} is not a rebind asset`);
    if (!isAddress(a)) throw new Error(`--${name} ${file}: ${id} → ${JSON.stringify(a)} is not an address`);
    out[Number(id)] = getAddress(a);
  }
  return out;
}

async function retry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  throw last;
}

function evmReader(net: Network) {
  return createPublicClient({ transport: http(net.url.replace("ws://", "http://").replace("[::]", "127.0.0.1")) });
}

async function evmOk(net: Network, res: EthTxResult): Promise<boolean> {
  const evs = await eventsAt(net, res.blockHash, true);
  const executed = pick(evs, "Ethereum", "Executed").map(
    (e) => e.event.value.value as { exit_reason: { type: string } },
  );
  return executed.length > 0 && executed.every((x) => x.exit_reason.type === "Succeed");
}

function sameRuntimeCode(code: string): boolean {
  const mask = (hex: string) => {
    let s = hex.toLowerCase().replace(/^0x/, "");
    for (const refs of Object.values(CONVERTER_RUNTIME.immutableReferences ?? {})) {
      for (const { start, length } of refs) s = s.slice(0, start * 2) + "0".repeat(length * 2) + s.slice((start + length) * 2);
    }
    return s;
  };
  return code.length === CONVERTER_RUNTIME.object.length && mask(code) === mask(CONVERTER_RUNTIME.object);
}

async function deployConverter(net: Network, merges: Row[], owner: Hex, check: Check): Promise<Hex> {
  const deployer = privateKeyToAccount(DEPLOYER_PK);
  const sub = hdxAccount(truncatedEvmAccount(deployer.address));
  await net.setStorage({
    System: { Account: [[[sub], { providers: 1, data: { free: 10n ** 18n } }]] },
    Tokens: { Accounts: [[[sub, WETH_ID], { free: 100n * 10n ** 18n }]] },
    EVMAccounts: { ContractDeployer: [[[deployer.address], true]] },
  });
  const client = new EthClient(net, deployer, { chainId: EVM_CHAIN_ID, gas: 8_000_000n });
  const impl = await client.deploy(CONVERTER.bytecode.object);
  check("converter impl deployed on the fork", await evmOk(net, impl.res), impl.address);
  const init = encodeFunctionData({ abi: CONVERTER.abi, functionName: "initialize" });
  const proxy = await client.deploy(
    encodeDeployData({ abi: PROXY.abi, bytecode: PROXY.bytecode.object, args: [impl.address, init] }),
  );
  check("converter proxy deployed on the fork", await evmOk(net, proxy.res), proxy.address);
  for (const m of merges) {
    const data = encodeFunctionData({ abi: CONVERTER.abi, functionName: "setPair", args: [precompile(m.id), precompile(m.twin!)] });
    check(`setPair ${m.symbol}.sb ${m.id} → ${m.twin}`, await evmOk(net, await client.call(proxy.address, data)));
  }
  const handover = encodeFunctionData({ abi: CONVERTER.abi, functionName: "setOwner", args: [owner] });
  check(`setOwner ${owner}`, await evmOk(net, await client.call(proxy.address, handover)));
  return proxy.address;
}

async function checkConverter(net: Network, converter: Hex, merges: Row[], owner: Hex, check: Check): Promise<string[]> {
  const hdx: any = net.client.getUnsafeApi();
  const pub = evmReader(net);
  const read = (functionName: string, args: unknown[] = []) =>
    retry(() => pub.readContract({ address: converter, abi: CONVERTER.abi, functionName, args } as never) as Promise<unknown>);
  const issues: string[] = [];
  const o = String(await read("owner"));
  if (o.toLowerCase() !== owner.toLowerCase()) issues.push(`owner ${o} is not ${owner}`);
  if (await read("paused")) issues.push("paused");
  for (const m of merges) {
    const t = String(await read("targetOf", [precompile(m.id)]));
    if (t.toLowerCase() !== precompile(m.twin!).toLowerCase()) issues.push(`${m.symbol}.sb pairs with ${t}, not ${m.twin}`);
  }
  // chopsticks' eth_getStorageAt answers zero, so read pallet_evm storage
  const slot = await hdx.query.EVM.AccountStorages.getValue(converter, ERC1967_IMPL_SLOT);
  const slotHex = typeof slot === "string" ? slot : Binary.toHex(slot);
  const impl = getAddress(`0x${slotHex.slice(-40)}`);
  if (!sameRuntimeCode(await getAccountCode(net, impl))) issues.push(`implementation ${impl} is not this build's SnowbridgeConverter`);
  check(
    `converter ${converter}: owner ${owner}, unpaused, ${merges.length} pairs, implementation = local build`,
    issues.length === 0,
    issues.join(" | "),
  );
  return issues.map((i) => `converter: ${i}`);
}

// mirrors pallet-circuit-breaker IssuanceIncreaseFuse::can_mint
async function canMint(hdx: any, asset: number, amount: bigint, now: number): Promise<boolean> {
  const limit = (await hdx.query.AssetRegistry.Assets.getValue(asset))?.xcm_rate_limit as bigint | undefined;
  if (limit === undefined) return true;
  const state = await hdx.query.CircuitBreaker.AssetLockdownState.getValue(asset);
  if (!state) return amount <= limit;
  if (state.type === "Locked") return Number(state.value) <= now && amount <= limit;
  const [resetAt, last] = state.value as [number, bigint];
  if (Number(resetAt) + DEPOSIT_PERIOD <= now) return amount <= limit;
  const issuance = (await hdx.query.Tokens.TotalIssuance.getValue(asset)) as bigint;
  return issuance - last + amount <= limit;
}

async function main(): Promise<void> {
  const stage = arg("stage") ?? "both";
  if (!["both", "switch", "transfer"].includes(stage)) throw new Error(`--stage ${stage}: use both, switch or transfer`);
  const final = flag("final");
  if (final && stage === "both") {
    throw new Error("--final needs --stage switch or --stage transfer: a transfer built on a simulated switch is never submittable");
  }
  const fees = {
    dotWithdraw: BigInt(arg("dot-withdraw") ?? DEFAULT_FEES.dotWithdraw),
    dotLocalFee: BigInt(arg("dot-fee") ?? DEFAULT_FEES.dotLocalFee),
    etherFee: BigInt(arg("ether-fee") ?? DEFAULT_FEES.etherFee),
  };
  const feeMargin = Number(arg("fee-margin") ?? 2);
  const restoreAfter = Number(arg("restore-after") ?? FUSE_RESTORE_AFTER);
  if (!(restoreAfter > DEPOSIT_PERIOD)) throw new Error(`--restore-after must exceed the ${DEPOSIT_PERIOD}-block deposit period`);
  const rebindIds = new Set(SNOWBRIDGE_ASSETS.filter((a) => a.cls === "rebind").map((a) => a.id));
  const spokesArg = addressMap("spokes", rebindIds);
  const hubsArg = addressMap("hubs", rebindIds);
  const ethFunderArg = addressArg("eth-funder");
  const converterArg = addressArg("converter");
  const custodian = addressArg("converter-owner") ?? EMERGENCY_ADMIN;
  if (stage === "transfer" && !converterArg) throw new Error("--stage transfer needs --converter");

  const nets = await spawnForks(FORK_SPECS);
  const { hydration, assetHub, bridgeHub } = nets;
  const { check, failed } = checklist();
  const switchBlockers: string[] = [];
  const transferBlockers: string[] = [];
  const outputs: { kind: string; blockers: string[]; body: Record<string, unknown> }[] = [];

  try {
    const hdx: any = hydration.client.getUnsafeApi();
    const ah: any = assetHub.client.getUnsafeApi();
    const bh: any = bridgeHub.client.getUnsafeApi();
    const sa = ahAccount(HYDRATION_SA_ON_ASSET_HUB);
    const treasury = hdxAccount(modl("py/trsry"));
    const heads = () => ({
      hydration: hydration.chain.head.number,
      assetHub: assetHub.chain.head.number,
      bridgeHub: bridgeHub.chain.head.number,
    });
    const forkedAt = heads();
    const free = async (who: string, id: number) =>
      ((await hdx.query.Tokens.Accounts.getValue(who, id))?.free ?? 0n) as bigint;
    const fuseOf = async (id: number) =>
      (await hdx.query.AssetRegistry.Assets.getValue(id))?.xcm_rate_limit as bigint | undefined;

    const rows: Row[] = [];
    const states = new Map<string, string[]>();
    for (const a of SNOWBRIDGE_ASSETS) {
      const loc = await hdx.query.AssetRegistry.AssetLocations.getValue(a.id);
      const state = sameValue(loc, tokenLocation(a.token))
        ? "snowbridge"
        : sameValue(loc, switchedLocationShape(a))
          ? "switched"
          : `unexpected ${toJson(loc)}`;
      states.set(state, [...(states.get(state) ?? []), a.symbol]);
      rows.push({ ...a, issuance: (await hdx.query.Tokens.TotalIssuance.getValue(a.id)) as bigint });
    }
    if (states.size !== 1) {
      throw new Error(`assets are not in one state: ${[...states].map(([s, xs]) => `${s} (${xs.join(", ")})`).join(" | ")}`);
    }
    const [live] = states.keys();
    if (stage === "transfer" && live !== "switched") throw new Error("the switch has not enacted on this chain yet");
    if (stage !== "transfer" && live !== "snowbridge") {
      throw new Error("the switch has already enacted on this chain: build the transfer with --stage transfer");
    }
    const rebinds = rows.filter((r) => r.cls === "rebind");
    const merges = rows.filter((r) => r.cls === "merge");

    const readSa = async () => {
      const tokens: Record<number, bigint> = {};
      const supply: Record<number, bigint> = {};
      for (const r of rows) {
        const loc = tokenLocation(r.token);
        tokens[r.id] = ((await ah.query.ForeignAssets.Account.getValue(loc, sa))?.balance ?? 0n) as bigint;
        supply[r.id] = ((await ah.query.ForeignAssets.Asset.getValue(loc))?.supply ?? 0n) as bigint;
      }
      return {
        tokens,
        supply,
        dot: (await ah.query.System.Account.getValue(sa)).data.free as bigint,
        usdt: ((await ah.query.Assets.Account.getValue(USDT_AH, sa))?.balance ?? 0n) as bigint,
        usdc: ((await ah.query.Assets.Account.getValue(USDC_AH, sa))?.balance ?? 0n) as bigint,
        ksm: ((await ah.query.ForeignAssets.Account.getValue(KSM_LOCATION, sa))?.balance ?? 0n) as bigint,
        myth: ((await ah.query.ForeignAssets.Account.getValue(MYTH_LOCATION, sa))?.balance ?? 0n) as bigint,
      };
    };

    const sa0 = await readSa();
    console.log(`\n🥢 ${rows.length} Snowbridge assets, ${live} (Hydration #${forkedAt.hydration}, Asset Hub #${forkedAt.assetHub})`);
    for (const r of rows) {
      console.log(`   ${String(r.id).padStart(7)} ${r.symbol.padEnd(7)} ${r.cls.padEnd(6)} issuance ${r.issuance}  SA ${sa0.tokens[r.id]}`);
    }

    console.log(`\n🥢 Converter`);
    const converter = converterArg ?? (await deployConverter(hydration, merges, custodian, check));
    if (!converterArg) switchBlockers.push("converter deployed on the fork");
    const converterSub = hdxAccount(truncatedEvmAccount(converter));
    const converterIssues = await checkConverter(hydration, converter, merges, custodian, check);
    switchBlockers.push(...converterIssues);
    transferBlockers.push(...converterIssues);

    // ── proposal 1: switch ───────────────────────────────────────
    const fuses: { twin: number; limit: bigint; raised: bigint }[] = [];
    const restores: { twin: number; when: number; index: number }[] = [];
    if (stage !== "transfer") {
      console.log(`\n🥢 NTT spokes`);
      const spokes: Record<number, Hex> = {};
      const placeholderSpokes: string[] = [];
      const spokeIssues: string[] = [];
      const pub = evmReader(hydration);
      for (const r of rebinds) {
        spokes[r.id] = spokesArg[r.id] ?? placeholderSpoke(r.id);
        if (!spokesArg[r.id]) {
          placeholderSpokes.push(r.symbol);
          continue;
        }
        const [t, mode] = await Promise.all([
          retry(() => pub.readContract({ address: spokes[r.id], abi: NTT_ABI, functionName: "token" })),
          retry(() => pub.readContract({ address: spokes[r.id], abi: NTT_ABI, functionName: "getMode" })),
        ]);
        if (t.toLowerCase() !== precompile(r.id).toLowerCase()) spokeIssues.push(`${r.symbol}: token ${t}`);
        if (mode !== NTT_BURNING) spokeIssues.push(`${r.symbol}: mode ${mode}`);
      }
      check(
        `${rebinds.length - placeholderSpokes.length} real spokes verified on Hydration (token = asset precompile, BURNING)`,
        spokeIssues.length === 0,
        spokeIssues.join(" | "),
      );
      switchBlockers.push(...spokeIssues.map((i) => `spoke ${i}`));
      if (placeholderSpokes.length) switchBlockers.push(`placeholder spokes: ${placeholderSpokes.join(", ")}`);

      const mints = merges
        .filter((m) => m.issuance > 0n)
        .map((m) => ({ id: m.id, symbol: m.symbol, twin: m.twin!, amount: m.issuance }));
      const calls1: Call[] = [
        ...rows.map((r) => ({
          name: "AssetRegistry.update",
          hex: r.cls === "rebind" ? encodeWhLocation(r.id, r.token) : encodeRetireLocation(r.id, r.token),
          args: { asset_id: r.id, location: switchedLocationShape(r) },
        })),
        ...rebinds.map((r) => ({
          name: "EVMAccounts.set_ntt_minter",
          hex: encodeSetNttMinter(r.id, spokes[r.id]),
          args: { asset_id: r.id, minter: spokes[r.id] },
        })),
        { name: "CircuitBreaker.set_asset_category", hex: await encodeSetAssetCategoryExternal(hydration.client, APYUSD_ID) },
      ];
      for (const m of mints) {
        const limit = await fuseOf(m.twin);
        const lock = await hdx.query.CircuitBreaker.AssetLockdownState.getValue(m.twin);
        if (lock?.type === "Locked" && Number(lock.value) > hydration.chain.head.number) {
          switchBlockers.push(`twin ${m.twin} is locked down until #${lock.value}: the mint would be reserved`);
        }
        if (limit !== undefined) {
          fuses.push({ twin: m.twin, limit, raised: limit + m.amount });
          calls1.push({
            name: "AssetRegistry.update",
            hex: encodeSetXcmRateLimit(m.twin, limit + m.amount),
            args: { asset_id: m.twin, xcm_rate_limit: limit + m.amount },
          });
        }
        calls1.push({
          name: "Currencies.update_balance",
          hex: await encodeUpdateBalance(hydration.client, converterSub, m.twin, m.amount),
        });
        if (limit !== undefined) {
          calls1.push({
            name: "Scheduler.schedule_after",
            hex: await encodeScheduleAfter(hydration.client, restoreAfter, encodeSetXcmRateLimit(m.twin, limit)),
          });
        }
      }
      const p1 = await finalize(hydration, calls1);
      console.log(`\n🥢 Proposal 1 (switch): ${calls1.length} calls, inner ${p1.innerBytes} bytes, blake2-256 ${p1.innerHash}`);

      const twinIssuance0: Record<number, bigint> = {};
      for (const m of mints) twinIssuance0[m.twin] = (await hdx.query.Tokens.TotalIssuance.getValue(m.twin)) as bigint;

      const e1 = await enactWhitelisted(hydration, p1.outer, p1.innerHash);
      const enactedAt = hydration.chain.head.number;
      if (!dispatchOk(e1.events, check)) for (const l of summarize(e1.events)) console.log(`     ${l}`);

      const badLocations: string[] = [];
      for (const r of rows) {
        const got = await hdx.query.AssetRegistry.AssetLocations.getValue(r.id);
        if (!sameValue(got, switchedLocationShape(r))) badLocations.push(`${r.symbol}: ${toJson(got)}`);
      }
      check(`${rows.length} locations repointed (${rebinds.length} wh provenance, ${rows.length - rebinds.length} retired)`, badLocations.length === 0, badLocations.join(" | "));

      const badMinters: string[] = [];
      for (const r of rebinds) {
        const got = String(await hdx.query.EVMAccounts.NttMinters.getValue(r.id)).toLowerCase();
        if (got !== spokes[r.id].toLowerCase()) badMinters.push(`${r.symbol}: ${got}`);
      }
      check(`${rebinds.length} NTT minters bound`, badMinters.length === 0, badMinters.join(" | "));

      const category = toJson(await hdx.query.CircuitBreaker.GlobalAssetOverrides.getValue(APYUSD_ID));
      check("apyUSD withdraw-limit override = External", category.includes("External"), category);

      for (const m of mints) {
        const held = await free(converterSub, m.twin);
        const issuance = (await hdx.query.Tokens.TotalIssuance.getValue(m.twin)) as bigint;
        check(
          `converter inventory ${m.twin} = ${m.symbol}.sb issuance, none reserved`,
          held === m.amount && issuance - twinIssuance0[m.twin] === m.amount,
          `${held}`,
        );
      }
      for (const f of fuses) {
        const now = await fuseOf(f.twin);
        check(`fuse of ${f.twin} raised by the mint`, now === f.raised, `${f.limit} → ${now}`);
      }

      const scheduled = pick(e1.events, "Scheduler", "Scheduled").map((e) => e.event.value.value as { when: number; index: number });
      const badRestores: string[] = [];
      for (const [i, f] of fuses.entries()) {
        const s = scheduled[i];
        if (!s || s.when <= enactedAt + DEPOSIT_PERIOD) {
          badRestores.push(`${f.twin}: ${toJson(s)}`);
          continue;
        }
        const task = ((await hdx.query.Scheduler.Agenda.getValue(s.when)) as any[])[s.index];
        const raw = task?.call?.type === "Inline" ? task.call.value : undefined;
        const decoded = raw ? await decodeCall(hydration.client, (typeof raw === "string" ? raw : Binary.toHex(raw)) as Hex) : undefined;
        const ok =
          decoded !== undefined &&
          callName(decoded) === "AssetRegistry.update" &&
          sameValue(
            Object.fromEntries(Object.entries(decoded.value.value).filter(([, v]) => v !== undefined)),
            { asset_id: f.twin, xcm_rate_limit: f.limit },
          ) &&
          toJson(task.origin).includes("Root");
        if (ok) restores.push({ twin: f.twin, when: s.when, index: s.index });
        else badRestores.push(`${f.twin}: ${toJson(task)}`.slice(0, 300));
      }
      check(
        `${fuses.length} fuse restores scheduled as Root at #${restores[0]?.when} (> switch #${enactedAt} + ${DEPOSIT_PERIOD})`,
        badRestores.length === 0 && scheduled.length === fuses.length,
        badRestores.join(" | "),
      );

      console.log(`\n🥢 Snowbridge closed`);
      const tbtc = rows.find((r) => r.id === TBTC_ID)!;
      const transferCall = async (location: unknown): Promise<Hex> =>
        Binary.toHex(
          await hdx.tx.PolkadotXcm.transfer_assets({
            dest: {
              type: "V5",
              value: { parents: 1, interior: { type: "X1", value: { type: "Parachain", value: ASSET_HUB_PARA_ID } } },
            },
            beneficiary: {
              type: "V5",
              value: {
                parents: 0,
                interior: {
                  type: "X1",
                  value: { type: "AccountId32", value: { network: undefined, id: HYDRATION_SA_ON_ASSET_HUB } },
                },
              },
            },
            assets: { type: "V5", value: [{ id: location, fun: { type: "Fungible", value: 10n ** 14n } }] },
            fee_asset_item: 0,
            weight_limit: { type: "Unlimited", value: undefined },
          }).getEncodedData(),
        ) as Hex;
      {
        const before = await free(treasury, TBTC_ID);
        const { events } = await dispatchAs(hydration, await transferCall(tokenLocation(tbtc.token)), {
          system: { Signed: treasury },
        });
        const result = pick(events, "Scheduler", "Dispatched").map((e) => toJson(e.event.value.value)).join(" ");
        check(
          "XCM transfer of tBTC via the old Snowbridge location rejected",
          result.includes('"success":false') && (await free(treasury, TBTC_ID)) === before,
          result.slice(0, 200),
        );
      }

      console.log(`\n🥢 Merge: convert USDC.sb → USDC 21 through the converter`);
      const user = privateKeyToAccount(USER_PK);
      const userSub = hdxAccount(truncatedEvmAccount(user.address));
      const convertAmount = 50_000_000n;
      await hydration.setStorage({
        System: { Account: [[[userSub], { providers: 1, data: { free: 10n ** 15n } }]] },
        Tokens: { Accounts: [[[userSub, WETH_ID], { free: 10n ** 18n }]] },
      });
      const fund = Binary.toHex(
        await hdx.tx.Currencies.transfer({ dest: userSub, currency_id: USDC_SB_ID, amount: convertAmount }).getEncodedData(),
      ) as Hex;
      await dispatchAs(hydration, fund, { system: { Signed: treasury } });
      check("test user funded with 50 USDC.sb from treasury", (await free(userSub, USDC_SB_ID)) === convertAmount);
      const conv21Before = await free(converterSub, 21);
      const uc = new EthClient(hydration, user, { chainId: EVM_CHAIN_ID, gas: 1_000_000n });
      const approve = await uc.call(
        precompile(USDC_SB_ID),
        encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [converter, convertAmount] }),
      );
      check("approve converter on the USDC.sb precompile", await evmOk(hydration, approve));
      const convert = await uc.call(
        converter,
        encodeFunctionData({ abi: CONVERTER.abi, functionName: "convert", args: [precompile(USDC_SB_ID), convertAmount] }),
      );
      check("convert(USDC.sb, 50)", await evmOk(hydration, convert));
      check(
        "balances after convert",
        (await free(userSub, 21)) === convertAmount &&
          (await free(userSub, USDC_SB_ID)) === 0n &&
          (await free(converterSub, USDC_SB_ID)) === convertAmount &&
          conv21Before - (await free(converterSub, 21)) === convertAmount,
        `user USDC21 ${await free(userSub, 21)}, converter USDC.sb ${await free(converterSub, USDC_SB_ID)}`,
      );

      outputs.push({
        kind: "switch",
        blockers: switchBlockers,
        body: {
          forkedAt,
          calls: p1,
          locations: rows.map((r) => ({ id: r.id, symbol: r.symbol, cls: r.cls, token: r.token, location: switchedLocationShape(r) })),
          nttMinters: rebinds.map((r) => ({ id: r.id, symbol: r.symbol, spoke: spokes[r.id], placeholder: !spokesArg[r.id] })),
          assetCategory: { id: APYUSD_ID, category: "External" },
          converter: { address: converter, account: converterSub, owner: custodian, deployedOnFork: !converterArg, mints },
          twinFuses: fuses.map((f) => ({ ...f, restoreAfterBlocks: restoreAfter })),
        },
      });
    }

    // ── proposal 2: transfer, one message per Ethereum destination ─
    let dotSpent: bigint | undefined;
    if (stage !== "switch") {
      console.log(`\n🥢 Transfer, built from the ${stage === "transfer" ? "live" : "forked (simulated)"} post-switch state`);
      let drift = 0n;
      if (stage === "both") {
        transferBlockers.push("built on a simulated switch");
        drift = 1_000_000n;
        const collected = await free(converterSub, USDC_SB_ID);
        for (const [who, amount] of [[converterSub, collected], [treasury, drift]] as const) {
          await dispatchAs(hydration, await encodeUpdateBalance(hydration.client, who, USDC_SB_ID, -amount), { system: "Root" });
        }
        console.log(`   drift: Root burns the converter's ${collected} collected USDC.sb and ${drift} USDC.sb of supply`);
      }
      const notSwitched: string[] = [];
      for (const r of rows) {
        const got = await hdx.query.AssetRegistry.AssetLocations.getValue(r.id);
        if (!sameValue(got, switchedLocationShape(r))) notSwitched.push(r.symbol);
      }
      if (notSwitched.length) throw new Error(`not switched: ${notSwitched.join(", ")}`);
      const minters: Record<number, Hex> = {};
      for (const id of [...rebinds.map((r) => r.id), ...merges.map((m) => m.twin!)]) {
        minters[id] = String(await hdx.query.EVMAccounts.NttMinters.getValue(id)) as Hex;
      }
      const placeholderMinters = rebinds.filter((r) => isPlaceholder(minters[r.id], r.id)).map((r) => r.symbol);
      if (placeholderMinters.length) transferBlockers.push(`placeholder spokes bound: ${placeholderMinters.join(", ")}`);
      for (const r of rebinds) {
        if (spokesArg[r.id] && spokesArg[r.id].toLowerCase() !== minters[r.id].toLowerCase()) {
          transferBlockers.push(`spoke ${r.symbol}: chain has ${minters[r.id]}, --spokes says ${spokesArg[r.id]}`);
        }
      }

      const ethHub = hubsArg[34] ?? placeholderHub(34);
      const ethFunder = ethFunderArg ?? placeholderFunder();
      const destOf = (r: Row): { dest: Hex; kind: string } => {
        if (r.cls === "merge") return { dest: TWIN_HUBS[r.twin!], kind: `existing hub ${r.twin}` };
        if (r.token === "ETH") return { dest: ethFunder, kind: "WETH hub funder" };
        return { dest: hubsArg[r.id] ?? placeholderHub(r.id), kind: "new hub" };
      };

      console.log(`\n🥢 Ethereum destinations`);
      const ethereum = createPublicClient({ transport: http(ETH_RPC) });
      const issues: string[] = [];
      const placeholderDests: string[] = [];
      const verifyHub = async (label: string, hub: Hex, token: Hex, spoke: string) => {
        const [t, mode, peer] = await Promise.all([
          ethereum.readContract({ address: hub, abi: NTT_ABI, functionName: "token" }),
          ethereum.readContract({ address: hub, abi: NTT_ABI, functionName: "getMode" }),
          ethereum.readContract({ address: hub, abi: NTT_ABI, functionName: "getPeer", args: [WORMHOLE_HYDRATION] }),
        ]);
        if (t.toLowerCase() !== token.toLowerCase()) issues.push(`${label}: token ${t}`);
        if (mode !== NTT_LOCKING) issues.push(`${label}: mode ${mode}`);
        if (peer.peerAddress.toLowerCase() !== pad(spoke as Hex, { size: 32 }).toLowerCase()) {
          issues.push(`${label}: peer ${peer.peerAddress} is not spoke ${spoke}`);
        }
      };
      let verified = 0;
      for (const r of rows.filter((x) => x.cls !== "retire")) {
        const d = destOf(r);
        if (isPlaceholder(d.dest, r.id)) {
          placeholderDests.push(r.symbol);
          continue;
        }
        if (r.cls === "merge") {
          await verifyHub(`${r.symbol}.sb → hub ${r.twin}`, d.dest, r.token as Hex, minters[r.twin!]);
        } else if (r.token === "ETH") {
          const [w, h] = await Promise.all([
            ethereum.readContract({ address: d.dest, abi: FUNDER_ABI, functionName: "weth" }),
            ethereum.readContract({ address: d.dest, abi: FUNDER_ABI, functionName: "hub" }),
          ]);
          if (w.toLowerCase() !== WETH_ETHEREUM.toLowerCase()) issues.push(`ETH funder: weth ${w}`);
          if (h.toLowerCase() !== ethHub.toLowerCase()) issues.push(`ETH funder: hub ${h} is not ${ethHub}`);
          if (isPlaceholder(ethHub, 34)) placeholderDests.push("ETH hub");
          else await verifyHub("ETH hub", ethHub, WETH_ETHEREUM, minters[34]);
        } else {
          await verifyHub(`${r.symbol} hub`, d.dest, r.token as Hex, minters[r.id]);
        }
        verified++;
        console.log(`   ${r.symbol.padEnd(7)} → ${d.kind} ${d.dest}`);
      }
      check(`${verified} real destinations verified on Ethereum (token, LOCKING, peer = Hydration spoke)`, issues.length === 0, issues.join(" | "));
      transferBlockers.push(...issues);
      if (placeholderDests.length) transferBlockers.push(`placeholder destinations: ${placeholderDests.join(", ")}`);

      console.log(`\n🥢 Relayer fee`);
      const quote = (await ah.apis.AssetConversionApi.quote_price_tokens_for_exact_tokens(
        DOT_LOCATION,
        ETHER_LOCATION,
        fees.etherFee,
        true,
      )) as bigint | undefined;
      const budget = fees.dotWithdraw - fees.dotLocalFee;
      const feeOk = check(
        `${dot(budget)} DOT per message buys the ${fees.etherFee} wei relayer fee ≥ ${feeMargin}× over`,
        quote !== undefined && budget * 100n >= quote * BigInt(Math.round(feeMargin * 100)),
        `quote ${dot(quote)} DOT`,
      );
      if (!feeOk) transferBlockers.push(`relayer fee budget ${dot(budget)} DOT < ${feeMargin} × quote ${dot(quote)} DOT`);

      const sa1 = await readSa();
      const exits = rows
        .filter((r) => r.cls !== "retire" && sa1.tokens[r.id] > 0n)
        .map((r) => ({ ...r, amount: sa1.tokens[r.id], ...destOf(r) }));
      const kept = rows.filter((r) => r.cls === "retire" && sa1.tokens[r.id] > 0n);

      const calls2: Call[] = [];
      const topics: Hex[] = [];
      for (const x of exits) {
        const topic = exitTopic(x.id, x.amount);
        topics.push(topic);
        const xcm = buildExitXcm({ token: x.token, amount: x.amount, beneficiary: x.dest, ...fees, topic });
        calls2.push({ name: "PolkadotXcm.send", hex: await encodeSendToAssetHub(hydration.client, xcm) });
      }

      console.log(`\n🥢 Converter inventory (outstanding .sb = issuance − collected)`);
      const needed: Record<number, bigint> = {};
      const trueups: { id: number; twin: number; needed: bigint; held: bigint; delta: bigint }[] = [];
      for (const m of merges) {
        const twin = m.twin!;
        const issuance = (await hdx.query.Tokens.TotalIssuance.getValue(m.id)) as bigint;
        const collected = await free(converterSub, m.id);
        const acct = await hdx.query.Tokens.Accounts.getValue(converterSub, twin);
        const held = (acct?.free ?? 0n) as bigint;
        const reserved = (acct?.reserved ?? 0n) as bigint;
        needed[twin] = issuance - collected;
        const delta = needed[twin] - held;
        console.log(`   ${m.symbol.padEnd(5)} → ${twin}: outstanding ${needed[twin]}, inventory ${held}, true-up ${delta}`);
        if (reserved > 0n) transferBlockers.push(`converter has ${reserved} of ${twin} reserved by the circuit breaker`);
        if (delta === 0n) continue;
        trueups.push({ id: m.id, twin, needed: needed[twin], held, delta });
        calls2.push({
          name: "Currencies.update_balance",
          hex: await encodeUpdateBalance(hydration.client, converterSub, twin, delta),
        });
        if (delta > 0n && !(await canMint(hdx, twin, delta, hydration.chain.head.number))) {
          transferBlockers.push(`true-up mint of ${delta} ${twin} would trip its fuse`);
        }
      }

      if (stage === "both") {
        const t = trueups.find((x) => x.twin === 21);
        check(`true-up of USDC 21 = −${drift}: burning collected USDC.sb leaves it alone`, t?.delta === -drift, toJson(t));
      }

      const p2 = await finalize(hydration, calls2);
      console.log(
        `\n🥢 Proposal 2 (transfer): ${exits.length} messages (one per destination), ${kept.length} dust assets left in the SA, ${trueups.length} true-ups, inner ${p2.innerBytes} bytes, blake2-256 ${p2.innerHash}`,
      );

      const nonce0 = (await bh.query.EthereumOutboundQueueV2.Nonce.getValue()) as bigint;
      const e2 = await enactWhitelisted(hydration, p2.outer, p2.innerHash);
      if (!dispatchOk(e2.events, check)) for (const l of summarize(e2.events)) console.log(`     ${l}`);
      check(`${exits.length} × PolkadotXcm.Sent`, pick(e2.events, "PolkadotXcm", "Sent").length === exits.length);
      const badInventory: string[] = [];
      for (const m of merges) {
        const held = await free(converterSub, m.twin!);
        if (held !== needed[m.twin!]) badInventory.push(`${m.twin}: ${held} ≠ ${needed[m.twin!]}`);
      }
      check("converter inventory = outstanding .sb for every twin", badInventory.length === 0, badInventory.join(" | "));

      console.log(`\n🥢 Asset Hub`);
      const processed: { success: boolean }[] = [];
      for (let i = 0; i < 12 && processed.length < exits.length; i++) {
        const b = await assetHub.chain.newBlock();
        const evs = await eventsAt(assetHub, b.hash);
        const ours = pick(evs, "MessageQueue", "Processed")
          .map((e) => e.event.value.value as { id: unknown; success: boolean })
          .filter((p) => topics.includes(String(p.id).toLowerCase() as Hex));
        processed.push(...ours);
        if (ours.length) console.log(`   #${b.number}: ${ours.length} message(s), all success ${ours.every((p) => p.success)}`);
        if (ours.some((p) => !p.success)) for (const l of summarize(evs)) console.log(`     ${l}`);
      }
      check(`${exits.length} messages processed`, processed.length === exits.length && processed.every((p) => p.success));

      const sa2 = await readSa();
      const badDrain: string[] = [];
      for (const x of exits) {
        const drop = sa1.tokens[x.id] - sa2.tokens[x.id];
        const supplyDrop = sa1.supply[x.id] - sa2.supply[x.id];
        const expectedSupplyDrop = x.token === "ETH" ? x.amount + fees.etherFee * BigInt(exits.length) : x.amount;
        if (drop !== x.amount || sa2.tokens[x.id] !== 0n || supplyDrop !== expectedSupplyDrop) {
          badDrain.push(`${x.symbol}: SA ${sa1.tokens[x.id]} → ${sa2.tokens[x.id]}, supply −${supplyDrop}`);
        }
      }
      check(`SA drained for all ${exits.length} assets (Asset Hub supply down by the same)`, badDrain.length === 0, badDrain.join(" | "));
      check(
        `dust left in the SA (${kept.map((r) => r.symbol).join(", ")})`,
        kept.every((r) => sa2.tokens[r.id] === sa1.tokens[r.id]),
      );
      dotSpent = sa1.dot - sa2.dot;
      check(
        "SA DOT spent on fees (Hydration DOT issuance unchanged)",
        dotSpent > 0n && dotSpent <= fees.dotWithdraw * BigInt(exits.length),
        `${dot(dotSpent)} DOT`,
      );
      check(
        "SA USDT/USDC (1984/1337), KSM, MYTH untouched",
        sa2.usdt === sa1.usdt && sa2.usdc === sa1.usdc && sa2.ksm === sa1.ksm && sa2.myth === sa1.myth,
      );

      console.log(`\n🥢 Bridge Hub`);
      const byTopic = new Map(exits.map((x, i) => [topics[i], x]));
      let accepted = 0;
      let queued = 0;
      const badCommands: string[] = [];
      for (let i = 0; i < 14 && accepted < exits.length; i++) {
        const b = await bridgeHub.chain.newBlock();
        const evs = await eventsAt(bridgeHub, b.hash);
        for (const q of pick(evs, "EthereumOutboundQueueV2", "MessageQueued")) {
          const msg = (q.event.value.value as {
            message: { id: unknown; commands: { type: string; value: { token: string; recipient: string; amount: bigint } }[] };
          }).message;
          const x = byTopic.get(String(msg.id).toLowerCase() as Hex);
          if (!x) continue;
          queued++;
          const c = msg.commands;
          const token = (x.token === "ETH" ? "0x0000000000000000000000000000000000000000" : x.token).toLowerCase();
          if (
            c.length !== 1 ||
            c[0].type !== "UnlockNativeToken" ||
            String(c[0].value.token).toLowerCase() !== token ||
            BigInt(c[0].value.amount) !== x.amount ||
            String(c[0].value.recipient).toLowerCase() !== x.dest.toLowerCase()
          ) {
            badCommands.push(`${x.symbol}: ${toJson(c)}`);
          }
        }
        const ours = pick(evs, "EthereumOutboundQueueV2", "MessageAccepted").filter((e) =>
          byTopic.has(String((e.event.value.value as { id: unknown }).id).toLowerCase() as Hex),
        );
        accepted += ours.length;
        if (ours.length) console.log(`   #${b.number}: ${ours.length} accepted`);
        const bhFailed = pick(evs, "MessageQueue", "Processed").filter((e) => (e.event.value.value as { success: boolean }).success === false);
        if (bhFailed.length) for (const l of summarize(evs)) console.log(`     ${l}`);
      }
      check(`${exits.length} messages accepted on Bridge Hub`, accepted === exits.length);
      check(
        "each message = one UnlockNativeToken to its hub / funder with the snapshot amount",
        queued === exits.length && badCommands.length === 0,
        badCommands.join(" | ").slice(0, 600),
      );
      const nonce1 = (await bh.query.EthereumOutboundQueueV2.Nonce.getValue()) as bigint;
      check(`outbound nonce +${exits.length}`, nonce1 - nonce0 === BigInt(exits.length), `${nonce0} → ${nonce1}`);

      outputs.push({
        kind: "transfer",
        blockers: transferBlockers,
        body: {
          forkedAt,
          builtOn: stage === "transfer" ? "live post-switch state" : "simulated switch",
          calls: p2,
          fees,
          feeQuote: { etherFee: fees.etherFee, dot: quote, margin: feeMargin },
          messages: exits.map((x, i) => ({
            topic: topics[i],
            beneficiary: x.dest,
            kind: x.kind,
            placeholder: isPlaceholder(x.dest, x.id),
            assets: [{ id: x.id, symbol: x.symbol, token: x.token, amount: x.amount, hydrationIssuance: x.issuance }],
          })),
          keptInSovereignAccount: kept.map((r) => ({ id: r.id, symbol: r.symbol, amount: sa1.tokens[r.id] })),
          converter: { address: converter, account: converterSub },
          converterTrueUps: trueups,
          dotFromSovereignAccount: {
            maxPerMessage: fees.dotWithdraw,
            spentOnFork: dotSpent,
            note: "fees come out of the SA's DOT, the reserve behind Hydration DOT; nothing is burned on Hydration",
          },
        },
      });
    }

    // ── the switch's scheduled fuse restore, after the mint's deposit window ─
    if (restores.length) {
      const at = restores[0].when;
      console.log(`\n🥢 Fuse restore at #${at}`);
      try {
        await hydration.setStorage({ Scheduler: { IncompleteSince: at } });
        const blk = await hydration.chain.newBlock({ unsafeBlockHeight: at });
        const evs = await eventsAt(hydration, blk.hash);
        const ran = pick(evs, "Scheduler", "Dispatched").map(
          (e) => e.event.value.value as { task: [number, number]; result: { success: boolean } },
        );
        const ours = ran.filter((r) => Number(r.task[0]) === at && r.result.success);
        check(`${restores.length} restores dispatched at #${blk.number}`, ours.length === restores.length, toJson(ran).slice(0, 300));
        for (const f of fuses) {
          const now = await fuseOf(f.twin);
          check(`fuse of ${f.twin} back to ${f.limit}`, now === f.limit, `${now}`);
        }
        const probe = hdxAccount(truncatedEvmAccount(privateKeyToAccount(USER_PK).address));
        for (const f of fuses) {
          const amount = f.limit < 1_000_000n ? f.limit : 1_000_000n;
          const before = await free(probe, f.twin);
          const { events } = await dispatchAs(hydration, await encodeUpdateBalance(hydration.client, probe, f.twin, amount), {
            system: "Root",
          });
          const lockdown = pick(events, "CircuitBreaker");
          check(
            `a ${amount} deposit of ${f.twin} after the restore leaves it unlocked`,
            lockdown.every((e) => e.event.value.type !== "AssetLockdown") && (await free(probe, f.twin)) - before === amount,
            summarize(lockdown).join(" | ").slice(0, 300),
          );
        }
      } catch (e) {
        check("fuse restore rehearsal", false, String(e).slice(0, 300));
      }
    }

    const bad = failed();
    if (bad.length) {
      for (const o of outputs) o.blockers.push(`${bad.length} rehearsal check(s) failed`);
    }
    console.log(`\n🥢 ${bad.length ? `❌ ${bad.length} check(s) failed` : "✅ all checks passed"}`);
    for (const o of outputs) {
      const submittable = final && o.blockers.length === 0;
      const file = `probes/snowbridge-${o.kind}-proposal${submittable ? "" : ".rehearsal"}.json`;
      writeFileSync(file, toJson({ stage: o.kind, submittable, blockers: o.blockers, ...o.body }, 2));
      console.log(`   ${o.kind}: ${submittable ? "submittable" : "NOT submittable"} → ${file}`);
      for (const b of o.blockers) console.log(`     ⚠️ ${b}`);
    }
    process.exitCode = bad.length || (final && outputs.some((o) => o.blockers.length)) ? 1 : 0;
  } finally {
    await teardownForks(nets);
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
