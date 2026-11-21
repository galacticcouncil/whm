/**
 * Build the Snowbridge switch and transfer proposals and rehearse both on Hydration + Asset Hub + Bridge Hub forks.
 *
 *   npx tsx probes/_probeSnowbridgeProposals.ts [--spokes <id→address json>] [--hubs <id→address json>]
 *     [--eth-funder <0x…>] [--converter <0x…>] [--ether-fee <wei>] [--dot-withdraw <planck>] [--dot-fee <planck>]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { AccountId, Binary } from "polkadot-api";
import {
  createPublicClient,
  encodeDeployData,
  encodeFunctionData,
  erc20Abi,
  http,
  pad,
  parseAbi,
  type Abi,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { EthClient, type EthTxResult } from "../lib/eth";
import { spawnForks, teardownForks, type Network } from "../lib/network";
import { toJson } from "../lib/utils";

import {
  FORK_SPECS,
  arg,
  checklist,
  dispatchAs,
  enactWhitelisted,
  eventsAt,
  pick,
  summarize,
  type Ev,
} from "./snowbridgeFork";
import {
  APYUSD_ID,
  ASSET_HUB_PARA_ID,
  HYDRATION_SA_ON_ASSET_HUB,
  SNOWBRIDGE_ASSETS,
  TWIN_HUBS,
  WETH_ETHEREUM,
  buildExitXcm,
  encodeBatchAll,
  encodeRetireLocation,
  encodeSendToAssetHub,
  encodeSetAssetCategoryExternal,
  encodeSetNttMinter,
  encodeUpdateBalance,
  encodeWhLocation,
  encodeSetXcmRateLimit,
  encodeWhitelistedDispatch,
  exitTopic,
  placeholderFunder,
  placeholderHub,
  placeholderSpoke,
  precompile,
  retiredLocationShape,
  tokenLocation,
  truncatedEvmAccount,
  whLocationShape,
  type SnowbridgeAsset,
  type SnowbridgeToken,
} from "./snowbridgeExit";

const EVM_CHAIN_ID = 222222;
const WETH_ID = 20;
const TBTC_ID = 1000765;
const USDC_SB_ID = 1000766;
const USDT_AH = 1984;
const USDC_AH = 1337;
const DEPLOYER_PK: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const USER_PK: Hex = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

const ETH_RPC = process.env.RPC_ETHEREUM ?? "https://ethereum-rpc.publicnode.com";
const NTT_HUB_ABI = parseAbi([
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

type Artifact = { abi: Abi; bytecode: { object: Hex } };
const OUT = resolve("../contracts/out");
const artifact = (path: string): Artifact => JSON.parse(readFileSync(resolve(OUT, path), "utf8"));
const CONVERTER = artifact("SnowbridgeConverter.sol/SnowbridgeConverter.json");
const PROXY = artifact("ERC1967Proxy.sol/ERC1967Proxy.default.json");

const hdxAccount = (pubkey: Hex) => AccountId(63).dec(Binary.fromHex(pubkey));
const ahAccount = (pubkey: Hex) => AccountId(0).dec(Binary.fromHex(pubkey));
const modl = (id: string): Hex => `0x${Buffer.from(`modl${id}`).toString("hex").padEnd(64, "0")}`;
const lower = (x: unknown) => toJson(x).toLowerCase();

interface Row extends SnowbridgeAsset {
  token: SnowbridgeToken;
  decimals: number;
  issuance: bigint;
}

type Check = ReturnType<typeof checklist>["check"];

async function evmOk(net: Network, res: EthTxResult): Promise<boolean> {
  const evs = await eventsAt(net, res.blockHash, true);
  const executed = pick(evs, "Ethereum", "Executed").map(
    (e) => e.event.value.value as { exit_reason: { type: string } },
  );
  return executed.length > 0 && executed.every((x) => x.exit_reason.type === "Succeed");
}

async function finalize(net: Network, calls: Hex[]) {
  const inner = encodeBatchAll(calls);
  const outer = encodeWhitelistedDispatch(inner);
  const registry = await net.chain.head.registry;
  const innerHash = registry.hash(Binary.fromHex(inner)).toHex() as Hex;
  return { inner, outer, innerHash, innerBytes: inner.length / 2 - 1, outerBytes: outer.length / 2 - 1 };
}

function dispatchOk(evs: Ev[], check: Check): boolean {
  const dispatched = pick(evs, "Scheduler", "Dispatched").map((e) => toJson(e.event.value.value));
  const wl = pick(evs, "Whitelist", "WhitelistedCallDispatched").map((e) => toJson(e.event.value.value));
  const a = check("Scheduler.Dispatched ok", dispatched.some((d) => d.includes('"success":true')), dispatched.join(" "));
  const b = check(
    "Whitelist.WhitelistedCallDispatched ok",
    wl.length > 0 && !wl.some((w) => w.includes('"success":false')),
    wl.join(" ").slice(0, 300),
  );
  const c = check(
    "Utility.BatchCompleted",
    pick(evs, "Utility", "BatchCompleted").length > 0 && pick(evs, "Utility", "BatchInterrupted").length === 0,
  );
  return a && b && c;
}

async function deployConverter(net: Network, merges: Row[], check: Check): Promise<Hex> {
  const deployer = privateKeyToAccount(DEPLOYER_PK);
  const sub = hdxAccount(truncatedEvmAccount(deployer.address));
  await net.setStorage({
    System: { Account: [[[sub], { providers: 1, data: { free: 10n ** 18n } }]] },
    Tokens: { Accounts: [[[sub, WETH_ID], { free: 100n * 10n ** 18n }]] },
    EVMAccounts: { ContractDeployer: [[[deployer.address], true]] },
  });
  const client = new EthClient(net, deployer, { chainId: EVM_CHAIN_ID, gas: 8_000_000n });
  const impl = await client.deploy(CONVERTER.bytecode.object);
  check("converter impl deployed", await evmOk(net, impl.res), impl.address);
  const init = encodeFunctionData({ abi: CONVERTER.abi, functionName: "initialize" });
  const proxy = await client.deploy(
    encodeDeployData({ abi: PROXY.abi, bytecode: PROXY.bytecode.object, args: [impl.address, init] }),
  );
  check("converter proxy deployed", await evmOk(net, proxy.res), proxy.address);
  for (const m of merges) {
    const res = await client.call(
      proxy.address,
      encodeFunctionData({
        abi: CONVERTER.abi,
        functionName: "setPair",
        args: [precompile(m.id), precompile(m.twin!)],
      }),
    );
    check(`setPair ${m.symbol}.sb ${m.id} → ${m.twin}`, await evmOk(net, res));
  }
  return proxy.address;
}

async function main(): Promise<void> {
  const fees = {
    dotWithdraw: BigInt(arg("dot-withdraw") ?? 50_000_000_000n),
    dotLocalFee: BigInt(arg("dot-fee") ?? 10_000_000_000n),
    etherFee: BigInt(arg("ether-fee") ?? 1_000_000_000_000_000n),
  };
  const spokesFile = arg("spokes");
  const spokes: Record<number, Hex> = spokesFile ? JSON.parse(readFileSync(spokesFile, "utf8")) : {};
  const hubsFile = arg("hubs");
  const hubs: Record<number, Hex> = hubsFile ? JSON.parse(readFileSync(hubsFile, "utf8")) : {};
  const ethFunder = (arg("eth-funder") as Hex | undefined) ?? placeholderFunder();

  const nets = await spawnForks(FORK_SPECS);
  const { hydration, assetHub, bridgeHub } = nets;
  const { check, failed } = checklist();

  try {
    const hdx: any = hydration.client.getUnsafeApi();
    const ah: any = assetHub.client.getUnsafeApi();
    const bh: any = bridgeHub.client.getUnsafeApi();
    const sa = ahAccount(HYDRATION_SA_ON_ASSET_HUB);
    const treasury = hdxAccount(modl("py/trsry"));
    const forkedAt = {
      hydration: hydration.chain.head.number,
      assetHub: assetHub.chain.head.number,
      bridgeHub: bridgeHub.chain.head.number,
    };

    const rows: Row[] = [];
    for (const a of SNOWBRIDGE_ASSETS) {
      const json = toJson(await hdx.query.AssetRegistry.AssetLocations.getValue(a.id));
      if (!json.includes("GlobalConsensus") || !json.includes("Ethereum")) {
        throw new Error(`${a.symbol} (${a.id}) is not Snowbridge-located: ${json}`);
      }
      const key = json.match(/"key":"(0x[0-9a-fA-F]{40})"/);
      const meta = await hdx.query.AssetRegistry.Assets.getValue(a.id);
      rows.push({
        ...a,
        token: key ? (key[1].toLowerCase() as Hex) : "ETH",
        decimals: meta?.decimals ?? 0,
        issuance: (await hdx.query.Tokens.TotalIssuance.getValue(a.id)) as bigint,
      });
    }
    const rebinds = rows.filter((r) => r.cls === "rebind");
    const merges = rows.filter((r) => r.cls === "merge");
    for (const r of rebinds) spokes[r.id] ??= placeholderSpoke(r.id);
    const placeholders = rebinds.filter((r) => spokes[r.id] === placeholderSpoke(r.id)).map((r) => r.id);

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
    console.log(`\n🥢 ${rows.length} Snowbridge assets (Hydration #${forkedAt.hydration}, Asset Hub #${forkedAt.assetHub})`);
    for (const r of rows) {
      console.log(`   ${String(r.id).padStart(7)} ${r.symbol.padEnd(7)} ${r.cls.padEnd(6)} issuance ${r.issuance}  SA ${sa0.tokens[r.id]}`);
    }

    console.log(`\n🥢 Converter`);
    let converter = arg("converter") as Hex | undefined;
    const converterDeployedOnFork = !converter;
    if (!converter) converter = await deployConverter(hydration, merges, check);
    const converterSub = hdxAccount(truncatedEvmAccount(converter));

    // ── proposal 1: switch ───────────────────────────────────────
    const mints = merges.filter((m) => m.issuance > 0n).map((m) => ({ id: m.id, symbol: m.symbol, twin: m.twin!, amount: m.issuance }));
    const calls1: Hex[] = [
      ...rows.map((r) => (r.cls === "rebind" ? encodeWhLocation(r.id, r.token) : encodeRetireLocation(r.id, r.token))),
      ...rebinds.map((r) => encodeSetNttMinter(r.id, spokes[r.id])),
      await encodeSetAssetCategoryExternal(hydration.client, APYUSD_ID),
    ];
    const fuses: { twin: number; limit: bigint; raised: bigint }[] = [];
    for (const m of mints) {
      const limit = (await hdx.query.AssetRegistry.Assets.getValue(m.twin))?.xcm_rate_limit as bigint | undefined;
      if (limit !== undefined) {
        fuses.push({ twin: m.twin, limit, raised: limit + m.amount });
        calls1.push(encodeSetXcmRateLimit(m.twin, limit + m.amount));
      }
      calls1.push(await encodeUpdateBalance(hydration.client, converterSub, m.twin, m.amount));
    }
    const p1 = await finalize(hydration, calls1);
    writeFileSync(
      "probes/snowbridge-switch-proposal.json",
      toJson(
        {
          forkedAt,
          calls: p1,
          locations: rows.map((r) => ({
            id: r.id,
            symbol: r.symbol,
            cls: r.cls,
            token: r.token,
            location: r.cls === "rebind" ? whLocationShape(r.token) : retiredLocationShape(r.token),
          })),
          nttMinters: rebinds.map((r) => ({ id: r.id, symbol: r.symbol, spoke: spokes[r.id], placeholder: placeholders.includes(r.id) })),
          assetCategory: { id: APYUSD_ID, category: "External" },
          converter: { address: converter, account: converterSub, deployedOnFork: converterDeployedOnFork, mints },
          twinFusesRaised: fuses,
        },
        2,
      ),
    );
    console.log(`\n🥢 Proposal 1 (switch): ${calls1.length} calls, inner ${p1.innerBytes} bytes, blake2-256 ${p1.innerHash}`);
    if (placeholders.length) console.log(`   ⚠️ ${placeholders.length} NTT spokes are placeholders (not deployed yet)`);

    const twinIssuance0: Record<number, bigint> = {};
    for (const m of mints) twinIssuance0[m.twin] = (await hdx.query.Tokens.TotalIssuance.getValue(m.twin)) as bigint;

    const e1 = await enactWhitelisted(hydration, p1.outer, p1.innerHash);
    if (!dispatchOk(e1.events, check)) for (const l of summarize(e1.events)) console.log(`     ${l}`);

    const badLocations: string[] = [];
    for (const r of rows) {
      const got = await hdx.query.AssetRegistry.AssetLocations.getValue(r.id);
      const want = r.cls === "rebind" ? whLocationShape(r.token) : retiredLocationShape(r.token);
      if (lower(got) !== lower(want)) badLocations.push(`${r.symbol}: ${toJson(got)}`);
    }
    check(`${rows.length} locations repointed (12 wh provenance, 8 retired)`, badLocations.length === 0, badLocations.join(" | "));

    const badMinters: string[] = [];
    for (const r of rebinds) {
      const got = String(await hdx.query.EVMAccounts.NttMinters.getValue(r.id)).toLowerCase();
      if (got !== spokes[r.id].toLowerCase()) badMinters.push(`${r.symbol}: ${got}`);
    }
    check(`${rebinds.length} NTT minters bound`, badMinters.length === 0, badMinters.join(" | "));

    const category = toJson(await hdx.query.CircuitBreaker.GlobalAssetOverrides.getValue(APYUSD_ID));
    check("apyUSD withdraw-limit override = External", category.includes("External"), category);

    for (const m of mints) {
      const held = ((await hdx.query.Tokens.Accounts.getValue(converterSub, m.twin))?.free ?? 0n) as bigint;
      const issuance = (await hdx.query.Tokens.TotalIssuance.getValue(m.twin)) as bigint;
      check(
        `converter inventory ${m.twin} = ${m.symbol}.sb issuance`,
        held === m.amount && issuance - twinIssuance0[m.twin] === m.amount,
        `${held}`,
      );
    }

    for (const f of fuses) {
      const now = (await hdx.query.AssetRegistry.Assets.getValue(f.twin))?.xcm_rate_limit as bigint | undefined;
      check(`fuse of ${f.twin} raised by the mint`, now === f.raised, `${f.limit} → ${now}`);
    }

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
      const before = ((await hdx.query.Tokens.Accounts.getValue(treasury, TBTC_ID))?.free ?? 0n) as bigint;
      const { events } = await dispatchAs(hydration, await transferCall(tokenLocation(tbtc.token)), {
        system: { Signed: treasury },
      });
      const result = pick(events, "Scheduler", "Dispatched").map((e) => toJson(e.event.value.value)).join(" ");
      const after = ((await hdx.query.Tokens.Accounts.getValue(treasury, TBTC_ID))?.free ?? 0n) as bigint;
      check("XCM transfer of tBTC via the old Snowbridge location rejected", result.includes('"success":false') && after === before, result.slice(0, 200));
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
    const bal = async (who: string, id: number) =>
      ((await hdx.query.Tokens.Accounts.getValue(who, id))?.free ?? 0n) as bigint;
    check("test user funded with 50 USDC.sb from treasury", (await bal(userSub, USDC_SB_ID)) === convertAmount);
    const conv21Before = await bal(converterSub, 21);
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
      (await bal(userSub, 21)) === convertAmount &&
        (await bal(userSub, USDC_SB_ID)) === 0n &&
        (await bal(converterSub, USDC_SB_ID)) === convertAmount &&
        conv21Before - (await bal(converterSub, 21)) === convertAmount,
      `user USDC21 ${await bal(userSub, 21)}, converter USDC.sb ${await bal(converterSub, USDC_SB_ID)}`,
    );

    // ── proposal 2: transfer, one message per Ethereum destination ─
    const ethHub = hubs[34] ?? placeholderHub(34);
    const destOf = (r: Row): { dest: Hex; kind: string; placeholder: boolean } => {
      if (r.cls === "merge") return { dest: TWIN_HUBS[r.twin!], kind: `existing hub ${r.twin}`, placeholder: false };
      if (r.token === "ETH") return { dest: ethFunder, kind: "WETH hub funder", placeholder: ethFunder === placeholderFunder() };
      const hub = hubs[r.id] ?? placeholderHub(r.id);
      return { dest: hub, kind: "new hub", placeholder: hub === placeholderHub(r.id) };
    };

    console.log(`\n🥢 Ethereum destinations`);
    const ethereum = createPublicClient({ transport: http(ETH_RPC) });
    const issues: string[] = [];
    const verifyHub = async (label: string, hub: Hex, token: Hex, spoke: string) => {
      const [t, mode, peer] = await Promise.all([
        ethereum.readContract({ address: hub, abi: NTT_HUB_ABI, functionName: "token" }),
        ethereum.readContract({ address: hub, abi: NTT_HUB_ABI, functionName: "getMode" }),
        ethereum.readContract({ address: hub, abi: NTT_HUB_ABI, functionName: "getPeer", args: [73] }),
      ]);
      if (t.toLowerCase() !== token.toLowerCase()) issues.push(`${label}: token ${t}`);
      if (mode !== 0) issues.push(`${label}: mode ${mode}`);
      if (peer.peerAddress.toLowerCase() !== pad(spoke as Hex, { size: 32 }).toLowerCase()) {
        issues.push(`${label}: peer ${peer.peerAddress} is not spoke ${spoke}`);
      }
    };
    let verified = 0;
    let placeholdersOut = 0;
    for (const r of rows.filter((x) => x.cls !== "retire")) {
      const d = destOf(r);
      if (d.placeholder) {
        placeholdersOut++;
        continue;
      }
      if (r.cls === "merge") {
        const spoke = String(await hdx.query.EVMAccounts.NttMinters.getValue(r.twin));
        await verifyHub(`${r.symbol}.sb → hub ${r.twin}`, d.dest, r.token as Hex, spoke);
      } else if (r.token === "ETH") {
        const [w, h] = await Promise.all([
          ethereum.readContract({ address: d.dest, abi: FUNDER_ABI, functionName: "weth" }),
          ethereum.readContract({ address: d.dest, abi: FUNDER_ABI, functionName: "hub" }),
        ]);
        if (w.toLowerCase() !== WETH_ETHEREUM.toLowerCase()) issues.push(`ETH funder: weth ${w}`);
        if (h.toLowerCase() !== ethHub.toLowerCase()) issues.push(`ETH funder: hub ${h} is not ${ethHub}`);
        if (ethHub !== placeholderHub(34)) await verifyHub("ETH hub", ethHub, WETH_ETHEREUM, spokes[34]);
      } else {
        await verifyHub(`${r.symbol} hub`, d.dest, r.token as Hex, spokes[r.id]);
      }
      verified++;
      console.log(`   ${r.symbol.padEnd(7)} → ${d.kind} ${d.dest}`);
    }
    check(`${verified} real destinations verified on Ethereum (token, LOCKING, peer = Hydration spoke)`, issues.length === 0, issues.join(" | "));
    if (placeholdersOut) console.log(`   ⚠️ ${placeholdersOut} destinations are placeholders (hubs / funder not deployed yet)`);

    const sa1 = await readSa();
    const exits = rows
      .filter((r) => r.cls !== "retire" && sa1.tokens[r.id] > 0n)
      .map((r) => ({ ...r, amount: sa1.tokens[r.id], ...destOf(r) }));
    const kept = rows.filter((r) => r.cls === "retire" && sa1.tokens[r.id] > 0n);

    const calls2: Hex[] = [];
    const topics: Hex[] = [];
    for (const x of exits) {
      const topic = exitTopic(x.id, x.amount);
      topics.push(topic);
      const xcm = buildExitXcm({ token: x.token, amount: x.amount, beneficiary: x.dest, ...fees, topic });
      calls2.push(await encodeSendToAssetHub(hydration.client, xcm));
    }
    const trueups: { twin: number; delta: bigint }[] = [];
    for (const m of mints) {
      const delta = ((await hdx.query.Tokens.TotalIssuance.getValue(m.id)) as bigint) - m.amount;
      if (delta !== 0n) {
        trueups.push({ twin: m.twin, delta });
        calls2.push(await encodeUpdateBalance(hydration.client, converterSub, m.twin, delta));
      }
    }
    for (const f of fuses) calls2.push(encodeSetXcmRateLimit(f.twin, f.limit));
    const p2 = await finalize(hydration, calls2);
    writeFileSync(
      "probes/snowbridge-transfer-proposal.json",
      toJson(
        {
          forkedAt: {
            hydration: hydration.chain.head.number,
            assetHub: assetHub.chain.head.number,
            bridgeHub: bridgeHub.chain.head.number,
          },
          calls: p2,
          fees,
          messages: exits.map((x, i) => ({
            topic: topics[i],
            beneficiary: x.dest,
            kind: x.kind,
            placeholder: x.placeholder,
            assets: [{ id: x.id, symbol: x.symbol, token: x.token, amount: x.amount }],
          })),
          keptInSovereignAccount: kept.map((r) => ({ id: r.id, symbol: r.symbol, amount: sa1.tokens[r.id] })),
          converterTrueUps: trueups,
          twinFusesRestored: fuses.map((f) => ({ twin: f.twin, limit: f.limit })),
        },
        2,
      ),
    );
    console.log(
      `\n🥢 Proposal 2 (transfer): ${exits.length} messages (one per destination), ${kept.length} dust assets left in the SA, ${trueups.length} true-ups, inner ${p2.innerBytes} bytes, blake2-256 ${p2.innerHash}`,
    );

    const nonce0 = (await bh.query.EthereumOutboundQueueV2.Nonce.getValue()) as bigint;
    const e2 = await enactWhitelisted(hydration, p2.outer, p2.innerHash);
    if (!dispatchOk(e2.events, check)) for (const l of summarize(e2.events)) console.log(`     ${l}`);
    check(`${exits.length} × PolkadotXcm.Sent`, pick(e2.events, "PolkadotXcm", "Sent").length === exits.length);

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
    const dotSpent = sa1.dot - sa2.dot;
    check(
      "SA DOT spent on fees",
      dotSpent > 0n && dotSpent <= fees.dotWithdraw * BigInt(exits.length),
      `${Number(dotSpent) / 1e10} DOT`,
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

    for (const f of fuses) {
      const now = (await hdx.query.AssetRegistry.Assets.getValue(f.twin))?.xcm_rate_limit as bigint | undefined;
      check(`fuse of ${f.twin} restored`, now === f.limit, `${now}`);
    }

    const bad = failed();
    console.log(`\n🥢 ${bad.length ? `❌ ${bad.length} check(s) failed` : "✅ all checks passed"}`);
    process.exitCode = bad.length ? 1 : 0;
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
