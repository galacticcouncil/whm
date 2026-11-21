import "dotenv/config";

import { readFileSync } from "node:fs";

import { AccountId, createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { createPublicClient, http, isAddress, parseAbi, type Address } from "viem";

import { acc } from "@galacticcouncil/common";
import { SNOWBRIDGE_ASSETS, TWIN_HUBS, tokenLocation, type SnowbridgeAsset } from "@whm/common/snowbridge";

const HYDRATION_WS = process.env.RPC_HYDRATION_WS ?? "wss://hdx.tarn.hydration.cloud";
const HYDRATION_EVM = process.env.RPC_HYDRATION ?? "https://rpc.hydradx.cloud";
const ASSET_HUB_WS = process.env.RPC_ASSET_HUB_WS ?? "wss://polkadot-asset-hub-rpc.polkadot.io";
const ETHEREUM = process.env.RPC_ETHEREUM ?? "https://ethereum-rpc.publicnode.com";

const SNOWBRIDGE_GATEWAY: Address = "0x27ca963C279c93801941e1eB8799c23f407d68e7";
const SNOWBRIDGE_AH_AGENT: Address = "0xd803472c47a87D7B63E888DE53f03B4191B846a8";
const MONEY_MARKET_POOL: Address = "0x1b02e051683b5cfac5929c25e84adb26ecf87b38";
const WORMHOLE_CHAIN_HYDRATION = 73;

const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
]);
const poolAbi = parseAbi([
  "function getReservesList() view returns (address[])",
  "function getReserveData(address) view returns ((uint256 data),uint128,uint128,uint128,uint128,uint128,uint40,uint16,address,address,address,address,uint128,uint128,uint128)",
]);
const nttAbi = parseAbi([
  "function getCurrentOutboundCapacity() view returns (uint256)",
  "function getCurrentInboundCapacity(uint16) view returns (uint256)",
  "function isPaused() view returns (bool)",
]);

const ss58 = AccountId(63);
const ss58Generic = AccountId(0);
const utf8 = new TextEncoder();

function palletAccount(id: string): string {
  const raw = new Uint8Array(32);
  raw.set([...utf8.encode("modl"), ...utf8.encode(id)]);
  return ss58.dec(raw);
}

function precompile(assetId: number): Address {
  return `0x00000000000000000000000000000001${assetId.toString(16).padStart(8, "0")}`;
}

function text(v: unknown): string | null {
  return v instanceof Uint8Array ? Buffer.from(v).toString("utf8") : null;
}

function units(v: bigint | null | undefined, decimals: number): string {
  if (v === null || v === undefined) return "";
  const sign = v < 0n ? "-" : "";
  const s = (v < 0n ? -v : v).toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s
    .slice(s.length - decimals)
    .replace(/0+$/, "")
    .slice(0, 4);
  return `${sign}${frac ? `${whole}.${frac}` : whole}`;
}

function json(v: unknown): string {
  return JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2);
}

// where the hydration location points: still snowbridge, or the switch's wh / sb marker
function route(location: unknown): string {
  const s = json(location).toLowerCase();
  if (s.includes('"globalconsensus"') && s.includes('"ethereum"')) return "snowbridge";
  if (s.includes('"0x7768')) return "wh";
  if (s.includes('"0x7362')) return "sb";
  return "other";
}

function getArgs() {
  const argv = process.argv.slice(2);
  const value = (flag: string) => {
    const i = argv.indexOf(flag);
    if (i < 0) return undefined;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value.`);
    return v;
  };
  const converter = value("--converter");
  if (converter !== undefined && !isAddress(converter)) throw new Error("Invalid --converter address.");
  const hubsFile = value("--hubs");
  const hubs: Record<number, Address> = {};
  for (const [id, hub] of Object.entries(hubsFile ? (JSON.parse(readFileSync(hubsFile, "utf8")) as Record<string, string>) : {})) {
    if (!isAddress(hub)) throw new Error(`Invalid --hubs address for ${id}.`);
    hubs[Number(id)] = hub;
  }
  return { converter: converter as Address | undefined, hubs, asJson: argv.includes("--json") };
}

function hubOf(a: SnowbridgeAsset, hubs: Record<number, Address>): { peer: number; hub: Address } | null {
  if (a.cls === "merge") return { peer: a.twin!, hub: TWIN_HUBS[a.twin!] };
  if (a.cls === "rebind" && hubs[a.id]) return { peer: a.id, hub: hubs[a.id] };
  return null;
}

async function main() {
  const { converter, hubs, asJson } = getArgs();

  const hdx = createClient(getWsProvider(HYDRATION_WS));
  const ah = createClient(getWsProvider(ASSET_HUB_WS));
  const hdxEvm = createPublicClient({ transport: http(HYDRATION_EVM) });
  const eth = createPublicClient({ transport: http(ETHEREUM) });

  try {
    const api: any = hdx.getUnsafeApi();
    const ahApi: any = ah.getUnsafeApi();
    const hdxBlock = await hdx.getFinalizedBlock();
    const ahBlock = await ah.getFinalizedBlock();
    const ethBlock = await eth.getBlockNumber();
    const at = { at: hdxBlock.hash };
    const ahAt = { at: ahBlock.hash };

    const sovereign = ss58Generic.dec(
      Uint8Array.from(Buffer.from(acc.getSovereignAccounts(2034).generic.slice(2), "hex")),
    );
    const treasury = palletAccount("py/trsry");
    const omnipool = palletAccount("omnipool");

    const omnipoolAssets = new Set(
      (await api.query.Omnipool.Assets.getEntries(at)).map((e: any) => e.keyArgs[0] as number),
    );
    const pools: { id: number; assets: number[] }[] = (
      await api.query.Stableswap.Pools.getEntries(at)
    ).map((e: any) => ({
      id: e.keyArgs[0] as number,
      assets: e.value.assets as number[],
    }));
    const hsm = new Set(
      (await api.query.HSM.Collaterals.getEntries(at)).map((e: any) => e.keyArgs[0] as number),
    );
    const minters = new Map<number, string>(
      (await api.query.EVMAccounts.NttMinters.getEntries(at)).map((e: any) => [
        e.keyArgs[0],
        e.value,
      ]),
    );
    const reserves = (
      await hdxEvm.readContract({
        address: MONEY_MARKET_POOL,
        abi: poolAbi,
        functionName: "getReservesList",
      })
    ).map((r) => r.toLowerCase());

    const assets = [];
    for (const a of SNOWBRIDGE_ASSETS) {
      const { id, token } = a;
      const location = tokenLocation(token);
      const hydrationLocation = await api.query.AssetRegistry.AssetLocations.getValue(id, at);
      const meta = await api.query.AssetRegistry.Assets.getValue(id, at);
      if (meta?.asset_type?.type !== "Token") continue;
      const decimals: number = meta.decimals ?? 0;
      const issuance: bigint = await api.query.Tokens.TotalIssuance.getValue(id, at);
      const treasuryAcc = await api.query.Tokens.Accounts.getValue(treasury, id, at);
      const omnipoolAcc = omnipoolAssets.has(id)
        ? await api.query.Tokens.Accounts.getValue(omnipool, id, at)
        : null;

      let moneyMarket = null;
      if (reserves.includes(precompile(id).toLowerCase())) {
        const rd = await hdxEvm.readContract({
          address: MONEY_MARKET_POOL,
          abi: poolAbi,
          functionName: "getReserveData",
          args: [precompile(id)],
        });
        moneyMarket = {
          supplied: await hdxEvm.readContract({
            address: rd[8],
            abi: erc20Abi,
            functionName: "totalSupply",
          }),
          borrowed: await hdxEvm.readContract({
            address: rd[10],
            abi: erc20Abi,
            functionName: "totalSupply",
          }),
        };
      }

      const ahAsset = await ahApi.query.ForeignAssets.Asset.getValue(location, ahAt);
      const ahAccount = await ahApi.query.ForeignAssets.Account.getValue(location, sovereign, ahAt);

      const agent =
        token === "ETH"
          ? await eth.getBalance({ address: SNOWBRIDGE_AH_AGENT })
          : await eth.readContract({
              address: token,
              abi: erc20Abi,
              functionName: "balanceOf",
              args: [SNOWBRIDGE_AH_AGENT],
            });
      const gateway =
        token === "ETH"
          ? await eth.getBalance({ address: SNOWBRIDGE_GATEWAY })
          : await eth.readContract({
              address: token,
              abi: erc20Abi,
              functionName: "balanceOf",
              args: [SNOWBRIDGE_GATEWAY],
            });

      const target = hubOf(a, hubs);
      let ntt = null;
      if (target) {
        const peerMeta = await api.query.AssetRegistry.Assets.getValue(target.peer, at);
        ntt = {
          peer: target.peer,
          peerDecimals: peerMeta?.decimals ?? null,
          peerIssuance: (await api.query.Tokens.TotalIssuance.getValue(target.peer, at)) as bigint,
          peerFuse: (peerMeta?.xcm_rate_limit ?? null) as bigint | null,
          minter: minters.get(target.peer) ?? null,
          hub: target.hub,
          hubOutbound: await eth.readContract({
            address: target.hub,
            abi: nttAbi,
            functionName: "getCurrentOutboundCapacity",
          }),
          hubInbound: await eth.readContract({
            address: target.hub,
            abi: nttAbi,
            functionName: "getCurrentInboundCapacity",
            args: [WORMHOLE_CHAIN_HYDRATION],
          }),
          hubPaused: await eth.readContract({
            address: target.hub,
            abi: nttAbi,
            functionName: "isPaused",
          }),
        };
      }

      // a merge's twin inventory must cover every .sb the converter has not collected yet
      let conversion = null;
      if (converter && a.cls === "merge") {
        const collected = await hdxEvm.readContract({
          address: precompile(id),
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [converter],
        });
        const inventory = await hdxEvm.readContract({
          address: precompile(a.twin!),
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [converter],
        });
        const outstanding = issuance - collected;
        conversion = { collected, inventory, outstanding, surplus: inventory - outstanding };
      }

      assets.push({
        id,
        cls: a.cls,
        route: route(hydrationLocation),
        symbol: text(meta.symbol),
        name: text(meta.name),
        decimals,
        token,
        issuance,
        fuse: (meta.xcm_rate_limit ?? null) as bigint | null,
        treasury: (treasuryAcc.free + treasuryAcc.reserved) as bigint,
        omnipool: (omnipoolAcc?.free ?? null) as bigint | null,
        pools: pools.filter((p) => p.assets.includes(id)).map((p) => p.id),
        moneyMarket,
        hsm: hsm.has(id),
        assetHub: {
          supply: (ahAsset?.supply ?? null) as bigint | null,
          hydrationSovereign: (ahAccount?.balance ?? 0n) as bigint,
          status: ahAsset?.status?.type ?? null,
        },
        ethereum: { agent, gateway },
        backingSurplus: ((ahAccount?.balance ?? 0n) as bigint) - issuance,
        conversion,
        ntt,
      });
    }

    const report = {
      hydration: { block: hdxBlock.number, hash: hdxBlock.hash },
      assetHub: { block: ahBlock.number, hash: ahBlock.hash, hydrationSovereign: sovereign },
      ethereum: { block: ethBlock },
      converter: converter ?? null,
      assets,
    };

    if (asJson) {
      console.log(json(report));
      return;
    }

    console.log(
      `hydration #${hdxBlock.number}  asset hub #${ahBlock.number}  ethereum #${ethBlock}`,
    );
    console.table(
      assets.map((a) => ({
        id: a.id,
        symbol: a.symbol,
        class: a.cls,
        route: a.route,
        issuance: units(a.issuance, a.decimals),
        "ah sovereign": units(a.assetHub.hydrationSovereign, a.decimals),
        surplus: units(a.backingSurplus, a.decimals),
        fuse: units(a.fuse, a.decimals),
        omnipool: units(a.omnipool, a.decimals),
        pools: a.pools.join(","),
        "mm supplied": units(a.moneyMarket?.supplied, a.decimals),
        "ntt peer": a.ntt?.peer ?? (a.cls === "retire" ? "" : "hub not given"),
        "peer fuse": a.ntt ? units(a.ntt.peerFuse, a.decimals) : "",
        "hub out": a.ntt ? units(a.ntt.hubOutbound, a.decimals) : "",
        inventory: a.conversion ? units(a.conversion.inventory, a.decimals) : "",
        "inventory surplus": a.conversion ? units(a.conversion.surplus, a.decimals) : "",
      })),
    );
  } finally {
    hdx.destroy();
    ah.destroy();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
