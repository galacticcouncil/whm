import { Binary, type PolkadotClient } from "polkadot-api";
import { keccak256, toHex, type Hex } from "viem";

import { acc } from "@galacticcouncil/common";

export const HYDRATION_PARA_ID = 2034;
export const ASSET_HUB_PARA_ID = 1000;
export const BRIDGE_HUB_PARA_ID = 1002;

export const TC_SAFE_ETHEREUM: Hex = "0xD557AeAf1e0cB3D226BfF3B7a10C2cdA9dA081E7";

export const HYDRATION_SA_ON_ASSET_HUB = acc.getSovereignAccounts(HYDRATION_PARA_ID).generic as Hex;

export const APYUSD_ID = 46;

export type AssetClass = "rebind" | "merge" | "retire";

export interface SnowbridgeAsset {
  id: number;
  symbol: string;
  cls: AssetClass;
  twin?: number;
}

export const SNOWBRIDGE_ASSETS: SnowbridgeAsset[] = [
  { id: 1000765, symbol: "tBTC", cls: "rebind" },
  { id: 46, symbol: "apyUSD", cls: "rebind" },
  { id: 34, symbol: "ETH", cls: "rebind" },
  { id: 1000809, symbol: "wstETH", cls: "rebind" },
  { id: 39, symbol: "PAXG", cls: "rebind" },
  { id: 1000766, symbol: "USDC", cls: "merge", twin: 21 },
  { id: 1000767, symbol: "USDT", cls: "merge", twin: 23 },
  { id: 35, symbol: "TRAC", cls: "rebind" },
  { id: 1000624, symbol: "AAVE", cls: "rebind" },
  { id: 1000794, symbol: "LINK", cls: "rebind" },
  { id: 1000795, symbol: "SKY", cls: "rebind" },
  { id: 1000796, symbol: "LDO", cls: "rebind" },
  { id: 38, symbol: "ENA", cls: "rebind" },
  { id: 1000625, symbol: "sUSDe", cls: "rebind" },
  { id: 1000189, symbol: "WETH", cls: "merge", twin: 20 },
  { id: 1000851, symbol: "LBTC", cls: "retire" },
  { id: 41, symbol: "CFG", cls: "retire" },
  { id: 1000190, symbol: "WBTC", cls: "merge", twin: 19 },
  { id: 1000626, symbol: "sUSDS", cls: "retire" },
  { id: 45, symbol: "sUSDat", cls: "retire" },
];

const ETHEREUM = { type: "Ethereum", value: { chain_id: 1n } };

export const DOT_LOCATION = { parents: 1, interior: { type: "Here", value: undefined } };
export const ETHER_LOCATION = {
  parents: 2,
  interior: { type: "X1", value: { type: "GlobalConsensus", value: ETHEREUM } },
};

export type SnowbridgeToken = Hex | "ETH";

export function tokenLocation(token: SnowbridgeToken) {
  if (token === "ETH") return ETHER_LOCATION;
  return {
    parents: 2,
    interior: {
      type: "X2",
      value: [
        { type: "GlobalConsensus", value: ETHEREUM },
        { type: "AccountKey20", value: { network: undefined, key: token.toLowerCase() } },
      ],
    },
  };
}

const fungible = (id: unknown, amount: bigint) => ({ id, fun: { type: "Fungible", value: amount } });

export interface ExitAsset {
  token: SnowbridgeToken;
  amount: bigint;
}

export interface ExitBatchParams {
  assets: ExitAsset[];
  beneficiary: Hex;
  dotWithdraw: bigint;
  dotLocalFee: bigint;
  etherFee: bigint;
  topic: Hex;
}

export interface ExitParams extends Omit<ExitBatchParams, "assets"> {
  token: SnowbridgeToken;
  amount: bigint;
}

export function exitTopic(assetId: number, amount: bigint): Hex {
  return keccak256(toHex(`hydration:snowbridge-exit:${assetId}:${amount}`));
}

export function batchTopic(ids: number[], amounts: bigint[]): Hex {
  return keccak256(toHex(`hydration:snowbridge-exit:${ids.join(",")}:${amounts.join(",")}`));
}

// xcm Assets must be sorted: ether (X1) sorts before every erc20 (X2), erc20s by key bytes
export function sortExitAssets(assets: ExitAsset[]): ExitAsset[] {
  const key = (a: ExitAsset) => (a.token === "ETH" ? "0" : `1${a.token.toLowerCase()}`);
  return [...assets].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

export function buildExitBatchXcm(p: ExitBatchParams) {
  const assets = sortExitAssets(p.assets).map((a) => fungible(tokenLocation(a.token), a.amount));
  const count = p.assets.length + 2;
  const refundTo = {
    parents: 0,
    interior: {
      type: "X1",
      value: { type: "AccountId32", value: { network: undefined, id: HYDRATION_SA_ON_ASSET_HUB } },
    },
  };
  const beneficiary = {
    parents: 0,
    interior: {
      type: "X1",
      value: { type: "AccountKey20", value: { network: undefined, key: p.beneficiary.toLowerCase() } },
    },
  };
  const allCounted = (n: number) => ({ type: "Wild", value: { type: "AllCounted", value: n } });

  // asset hub's paid-execution barrier caps the leading WithdrawAsset at 2 assets
  const withdraw =
    assets.length === 1
      ? [{ type: "WithdrawAsset", value: [fungible(DOT_LOCATION, p.dotWithdraw), ...assets] }]
      : [{ type: "WithdrawAsset", value: [fungible(DOT_LOCATION, p.dotWithdraw)] }];

  return [
    ...withdraw,
    { type: "PayFees", value: { asset: fungible(DOT_LOCATION, p.dotLocalFee) } },
    ...(assets.length === 1 ? [] : [{ type: "WithdrawAsset", value: assets }]),
    {
      type: "SetAppendix",
      value: [
        { type: "RefundSurplus", value: undefined },
        { type: "DepositAsset", value: { assets: allCounted(count), beneficiary: refundTo } },
      ],
    },
    {
      type: "ExchangeAsset",
      value: {
        give: {
          type: "Wild",
          value: { type: "AllOf", value: { id: DOT_LOCATION, fun: { type: "Fungible", value: undefined } } },
        },
        want: [fungible(ETHER_LOCATION, p.etherFee)],
        maximal: false,
      },
    },
    {
      type: "InitiateTransfer",
      value: {
        destination: ETHER_LOCATION,
        remote_fees: {
          type: "ReserveWithdraw",
          value: { type: "Definite", value: [fungible(ETHER_LOCATION, p.etherFee)] },
        },
        preserve_origin: true,
        assets: [{ type: "ReserveWithdraw", value: { type: "Definite", value: assets } }],
        remote_xcm: [
          { type: "DepositAsset", value: { assets: allCounted(count), beneficiary } },
          { type: "SetTopic", value: p.topic },
        ],
      },
    },
    { type: "SetTopic", value: p.topic },
  ];
}

export function buildExitXcm(p: ExitParams) {
  const { token, amount, ...rest } = p;
  return buildExitBatchXcm({ ...rest, assets: [{ token, amount }] });
}

export async function encodeSendToAssetHub(hydration: PolkadotClient, xcm: unknown[]): Promise<Hex> {
  const api = hydration.getUnsafeApi();
  const call = api.tx.PolkadotXcm.send({
    dest: {
      type: "V5",
      value: { parents: 1, interior: { type: "X1", value: { type: "Parachain", value: ASSET_HUB_PARA_ID } } },
    },
    message: { type: "V5", value: xcm },
  });
  return Binary.toHex(await call.getEncodedData()) as Hex;
}

function compact(n: number): string {
  if (n < 64) return (n << 2).toString(16).padStart(2, "0");
  if (n < 16384) {
    const v = (n << 2) | 1;
    return (v & 0xff).toString(16).padStart(2, "0") + (v >> 8).toString(16).padStart(2, "0");
  }
  if (n < 1073741824) {
    const v = (n << 2) | 2;
    let s = "";
    for (let i = 0; i < 4; i++) s += ((v >>> (8 * i)) & 0xff).toString(16).padStart(2, "0");
    return s;
  }
  throw new Error("compact too big");
}

const u32le = (n: number): string => n.toString(16).padStart(8, "0").match(/../g)!.reverse().join("");

export const SB_GENERAL_KEY = "7362" + "0".repeat(60);
export const WH_GENERAL_KEY = "7768" + "0".repeat(60);

const addr32 = (token: SnowbridgeToken): string =>
  (token === "ETH" ? "0x0" : token).replace(/^0x/, "").toLowerCase().padStart(64, "0");

function markerScale(key: string, index: number, token: SnowbridgeToken): string {
  return "00" + "03" + "06" + "02" + key + "05" + compact(index) + "06" + "20" + addr32(token);
}

function markerShape(key: string, index: number, token: SnowbridgeToken) {
  return {
    parents: 0,
    interior: {
      type: "X3",
      value: [
        { type: "GeneralKey", value: { length: 2, data: `0x${key}` } },
        { type: "GeneralIndex", value: String(index) },
        { type: "GeneralKey", value: { length: 32, data: `0x${addr32(token)}` } },
      ],
    },
  };
}

export const retiredLocationScale = (token: SnowbridgeToken) => markerScale(SB_GENERAL_KEY, 1, token);
export const retiredLocationShape = (token: SnowbridgeToken) => markerShape(SB_GENERAL_KEY, 1, token);
export const whLocationScale = (token: SnowbridgeToken) => markerScale(WH_GENERAL_KEY, 2, token);
export const whLocationShape = (token: SnowbridgeToken) => markerShape(WH_GENERAL_KEY, 2, token);

export function encodeLocationUpdate(assetId: number, locationScale: string): Hex {
  return `0x3301${u32le(assetId)}${"00".repeat(7)}01${locationScale}`;
}

export const encodeRetireLocation = (assetId: number, token: SnowbridgeToken): Hex =>
  encodeLocationUpdate(assetId, retiredLocationScale(token));

export const encodeWhLocation = (assetId: number, token: SnowbridgeToken): Hex =>
  encodeLocationUpdate(assetId, whLocationScale(token));

export function encodeSetXcmRateLimit(assetId: number, limit: bigint): Hex {
  const u128le = limit.toString(16).padStart(32, "0").match(/../g)!.reverse().join("");
  return `0x3301${u32le(assetId)}${"00".repeat(3)}01${u128le}${"00".repeat(4)}`;
}

export function encodeSetNttMinter(assetId: number, minter: Hex): Hex {
  return `0x5d07${u32le(assetId)}${minter.slice(2).toLowerCase()}`;
}

export async function encodeSetAssetCategoryExternal(hydration: PolkadotClient, assetId: number): Promise<Hex> {
  const call = hydration
    .getUnsafeApi()
    .tx.CircuitBreaker.set_asset_category({ asset_id: assetId, category: { type: "External", value: undefined } });
  return Binary.toHex(await call.getEncodedData()) as Hex;
}

export async function encodeUpdateBalance(
  hydration: PolkadotClient,
  who: string,
  currencyId: number,
  delta: bigint,
): Promise<Hex> {
  const call = hydration
    .getUnsafeApi()
    .tx.Currencies.update_balance({ who, currency_id: currencyId, amount: delta });
  return Binary.toHex(await call.getEncodedData()) as Hex;
}

export function encodeBatchAll(calls: Hex[]): Hex {
  return `0x0d02${compact(calls.length)}${calls.map((c) => c.slice(2)).join("")}`;
}

export function encodeWhitelistedDispatch(inner: Hex): Hex {
  return `0x2703${inner.slice(2)}`;
}

export const precompile = (assetId: number): Hex =>
  `0x00000000000000000000000000000001${assetId.toString(16).padStart(8, "0")}`;

export const truncatedEvmAccount = (h160: Hex): Hex => `0x45544800${h160.slice(2).toLowerCase()}${"00".repeat(8)}`;

export const placeholderSpoke = (assetId: number): Hex => `0x5b0c${assetId.toString(16).padStart(36, "0")}`;

export const placeholderHub = (assetId: number): Hex => `0x4b0b${assetId.toString(16).padStart(36, "0")}`;

export const placeholderFunder = (): Hex => `0xf0de${"0".repeat(36)}`;

export const WETH_ETHEREUM: Hex = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

export const TWIN_HUBS: Record<number, Hex> = {
  19: "0x081b76AC3cFb65DCe93961d66cea44A74EC8Ef28",
  20: "0x283B14B5Dd352e32154Df014EA96834F395E04b6",
  21: "0x447b2c7485A3d6813F8197E605b10BcCD8dd8398",
  23: "0x9fbd9F16cE7Fa17097E91cc36DC1B7b47aDCa9De",
};
