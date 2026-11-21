import "dotenv/config";

import { AccountId, createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { createPublicClient, http, isAddress, parseAbi, type Address } from "viem";

import { acc } from "@galacticcouncil/common";

const HYDRATION_WS = process.env.RPC_HYDRATION_WS ?? "wss://hdx.tarn.hydration.cloud";
const HYDRATION_EVM = process.env.RPC_HYDRATION ?? "https://rpc.hydradx.cloud";
const ASSET_HUB_WS = process.env.RPC_ASSET_HUB_WS ?? "wss://polkadot-asset-hub-rpc.polkadot.io";
const ETHEREUM = process.env.RPC_ETHEREUM ?? "https://ethereum-rpc.publicnode.com";

const SNOWBRIDGE_GATEWAY: Address = "0x27ca963C279c93801941e1eB8799c23f407d68e7";
const SNOWBRIDGE_AH_AGENT: Address = "0xd803472c47a87D7B63E888DE53f03B4191B846a8";
const MONEY_MARKET_POOL: Address = "0x1b02e051683b5cfac5929c25e84adb26ecf87b38";
const WORMHOLE_CHAIN_HYDRATION = 73;

const REUSE: Record<number, { peer: number; hub: Address }> = {
  34: { peer: 20, hub: "0x283B14B5Dd352e32154Df014EA96834F395E04b6" },
  1000189: { peer: 20, hub: "0x283B14B5Dd352e32154Df014EA96834F395E04b6" },
  1000190: { peer: 19, hub: "0x081b76AC3cFb65DCe93961d66cea44A74EC8Ef28" },
  1000766: { peer: 21, hub: "0x447b2c7485A3d6813F8197E605b10BcCD8dd8398" },
  1000767: { peer: 23, hub: "0x9fbd9F16cE7Fa17097E91cc36DC1B7b47aDCa9De" },
  1000626: { peer: 1000745, hub: "0x5085A4863f89eC9553F70187EE73B5aAe0fd14b5" },
};

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

function hasEthereumConsensus(location: unknown): boolean {
  const s = json(location);
  return s.includes('"GlobalConsensus"') && s.includes('"Ethereum"');
}

function tokenOf(location: unknown): Address | "ETH" {
  const m = json(location).match(/"key":\s*"(0x[0-9a-fA-F]{40})"/);
  return m ? (m[1] as Address) : "ETH";
}

function getArgs() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--converter");
  const converter = i >= 0 ? argv[i + 1] : undefined;
  if (converter !== undefined && !isAddress(converter))
    throw new Error("Invalid --converter address.");
  return { converter: converter as Address | undefined, asJson: argv.includes("--json") };
}

async function main() {
  const { converter, asJson } = getArgs();

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

    const locations = await api.query.AssetRegistry.AssetLocations.getEntries(at);
    const snowbridge = locations
      .filter((e: any) => hasEthereumConsensus(e.value))
      .map((e: any) => ({ id: e.keyArgs[0] as number, location: e.value }));

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
    for (const { id, location } of snowbridge) {
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

      const token = tokenOf(location);
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

      const reuse = REUSE[id];
      let ntt = null;
      if (reuse) {
        const peerMeta = await api.query.AssetRegistry.Assets.getValue(reuse.peer, at);
        ntt = {
          peer: reuse.peer,
          peerDecimals: peerMeta?.decimals ?? null,
          peerIssuance: (await api.query.Tokens.TotalIssuance.getValue(reuse.peer, at)) as bigint,
          peerFuse: (peerMeta?.xcm_rate_limit ?? null) as bigint | null,
          minter: minters.get(reuse.peer) ?? null,
          hub: reuse.hub,
          hubOutbound: await eth.readContract({
            address: reuse.hub,
            abi: nttAbi,
            functionName: "getCurrentOutboundCapacity",
          }),
          hubInbound: await eth.readContract({
            address: reuse.hub,
            abi: nttAbi,
            functionName: "getCurrentInboundCapacity",
            args: [WORMHOLE_CHAIN_HYDRATION],
          }),
          hubPaused: await eth.readContract({
            address: reuse.hub,
            abi: nttAbi,
            functionName: "isPaused",
          }),
          converterInventory: converter
            ? await hdxEvm.readContract({
                address: precompile(reuse.peer),
                abi: erc20Abi,
                functionName: "balanceOf",
                args: [converter],
              })
            : null,
        };
      }

      assets.push({
        id,
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
        converterHoldings: converter
          ? await hdxEvm.readContract({
              address: precompile(id),
              abi: erc20Abi,
              functionName: "balanceOf",
              args: [converter],
            })
          : null,
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
        issuance: units(a.issuance, a.decimals),
        "ah sovereign": units(a.assetHub.hydrationSovereign, a.decimals),
        surplus: units(a.backingSurplus, a.decimals),
        fuse: units(a.fuse, a.decimals),
        omnipool: units(a.omnipool, a.decimals),
        pools: a.pools.join(","),
        "mm supplied": units(a.moneyMarket?.supplied, a.decimals),
        "ntt peer": a.ntt?.peer ?? "new hub",
        "peer fuse": a.ntt ? units(a.ntt.peerFuse, a.decimals) : "",
        "hub out": a.ntt ? units(a.ntt.hubOutbound, a.decimals) : "",
        inventory:
          a.ntt?.converterInventory != null ? units(a.ntt.converterInventory, a.decimals) : "",
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
