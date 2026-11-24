import { Binary, type PolkadotClient } from "polkadot-api";
import { keccak256, toHex, type Hex } from "viem";

import { acc } from "@galacticcouncil/common";
import {
  ETHER_LOCATION,
  tokenLocation,
  type SnowbridgeAsset,
  type SnowbridgeToken,
} from "@whm/common/snowbridge";

export {
  EMERGENCY_ADMIN,
  ETHER_LOCATION,
  SNOWBRIDGE_ASSETS,
  TWIN_HUBS,
  WETH_ETHEREUM,
  tokenLocation,
  type AssetClass,
  type SnowbridgeAsset,
  type SnowbridgeToken,
} from "@whm/common/snowbridge";

export const HYDRATION_PARA_ID = 2034;
export const ASSET_HUB_PARA_ID = 1000;
export const BRIDGE_HUB_PARA_ID = 1002;

export const TC_SAFE_ETHEREUM: Hex = "0xD557AeAf1e0cB3D226BfF3B7a10C2cdA9dA081E7";

export const HYDRATION_SA_ON_ASSET_HUB = acc.getSovereignAccounts(HYDRATION_PARA_ID).generic as Hex;

export const APYUSD_ID = 46;

// circuit breaker deposit Period (DAYS at 2 s blocks); a window runs from its first deposit, not from the mint
export const DEPOSIT_PERIOD = 43_200;
export const FUSE_RESTORE_AFTER = DEPOSIT_PERIOD + 1_200;

export const DEFAULT_FEES = {
  dotWithdraw: 100_000_000_000n,
  dotLocalFee: 10_000_000_000n,
  etherFee: 1_000_000_000_000_000n,
};

export const DOT_LOCATION = { parents: 1, interior: { type: "Here", value: undefined } };

const fungible = (id: unknown, amount: bigint) => ({ id, fun: { type: "Fungible", value: amount } });

export interface ExitParams {
  token: SnowbridgeToken;
  amount: bigint;
  beneficiary: Hex;
  dotWithdraw: bigint;
  dotLocalFee: bigint;
  etherFee: bigint;
  topic: Hex;
}

export function exitTopic(assetId: number, amount: bigint): Hex {
  return keccak256(toHex(`hydration:snowbridge-exit:${assetId}:${amount}`));
}

// one token per message: asset hub's paid-execution barrier caps the leading WithdrawAsset at 2 assets
export function buildExitXcm(p: ExitParams) {
  const asset = fungible(tokenLocation(p.token), p.amount);
  const allCounted = { type: "Wild", value: { type: "AllCounted", value: 3 } };
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

  return [
    { type: "WithdrawAsset", value: [fungible(DOT_LOCATION, p.dotWithdraw), asset] },
    { type: "PayFees", value: { asset: fungible(DOT_LOCATION, p.dotLocalFee) } },
    {
      type: "SetAppendix",
      value: [
        { type: "RefundSurplus", value: undefined },
        { type: "DepositAsset", value: { assets: allCounted, beneficiary: refundTo } },
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
        assets: [{ type: "ReserveWithdraw", value: { type: "Definite", value: [asset] } }],
        remote_xcm: [
          { type: "DepositAsset", value: { assets: allCounted, beneficiary } },
          { type: "SetTopic", value: p.topic },
        ],
      },
    },
    { type: "SetTopic", value: p.topic },
  ];
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

export const switchedLocationShape = (a: SnowbridgeAsset) =>
  a.cls === "rebind" ? whLocationShape(a.token) : retiredLocationShape(a.token);

const normalize = (x: unknown): unknown => {
  if (typeof x === "bigint") return x.toString();
  if (x instanceof Uint8Array) return Binary.toHex(x);
  if (Array.isArray(x)) return x.map(normalize);
  if (x && typeof x === "object") {
    const o = x as Record<string, unknown> & { toJSON?: () => unknown };
    if (typeof o.toJSON === "function") return normalize(o.toJSON());
    // an X1 junction decodes as a one-element array under some xcm versions
    if (o.type === "X1" && Array.isArray(o.value) && o.value.length === 1) return { type: "X1", value: normalize(o.value[0]) };
    return Object.fromEntries(
      Object.entries(o)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, normalize(v)]),
    );
  }
  return x;
};

export const sameValue = (a: unknown, b: unknown): boolean =>
  JSON.stringify(normalize(a)).toLowerCase() === JSON.stringify(normalize(b)).toLowerCase();

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

export async function encodeScheduleAfter(hydration: PolkadotClient, after: number, call: Hex): Promise<Hex> {
  const api = hydration.getUnsafeApi();
  const { decodedCall } = await api.txFromCallData(Binary.fromHex(call));
  const tx = api.tx.Scheduler.schedule_after({ after, maybe_periodic: undefined, priority: 63, call: decodedCall });
  return Binary.toHex(await tx.getEncodedData()) as Hex;
}

export function encodeBatchAll(calls: Hex[]): Hex {
  return `0x0d02${compact(calls.length)}${calls.map((c) => c.slice(2)).join("")}`;
}

export function encodeWhitelistedDispatch(inner: Hex): Hex {
  return `0x2703${inner.slice(2)}`;
}

export interface Call {
  name: string;
  hex: Hex;
  // decoded args that must be set, every other arg must be None
  args?: Record<string, unknown>;
}

export type DecodedCall = { type: string; value: { type: string; value: Record<string, unknown> } };

export const callName = (c: DecodedCall) => `${c.type}.${c.value.type}`;

export async function decodeCall(hydration: PolkadotClient, hex: Hex): Promise<DecodedCall> {
  return (await hydration.getUnsafeApi().txFromCallData(Binary.fromHex(hex))).decodedCall as DecodedCall;
}

// decodes the whitelisted dispatch against the live metadata, so a hand-encoded call can't drift
export async function assertProposal(hydration: PolkadotClient, outer: Hex, calls: Call[]): Promise<void> {
  const wrapper = await decodeCall(hydration, outer);
  if (callName(wrapper) !== "Whitelist.dispatch_whitelisted_call_with_preimage") {
    throw new Error(`outer call decodes as ${callName(wrapper)}`);
  }
  const batch = wrapper.value.value.call as DecodedCall;
  if (callName(batch) !== "Utility.batch_all") throw new Error(`inner call decodes as ${callName(batch)}`);
  const decoded = batch.value.value.calls as DecodedCall[];
  if (decoded.length !== calls.length) throw new Error(`batch decodes to ${decoded.length} calls, built ${calls.length}`);
  decoded.forEach((d, i) => {
    const want = calls[i];
    if (callName(d) !== want.name) throw new Error(`call ${i} decodes as ${callName(d)}, built ${want.name}`);
    if (!want.args) return;
    const set = Object.entries(d.value.value).filter(([, v]) => v !== undefined);
    const ok =
      set.length === Object.keys(want.args).length && set.every(([k, v]) => k in want.args! && sameValue(v, want.args![k]));
    if (!ok) throw new Error(`call ${i} (${want.name}) decodes as ${JSON.stringify(normalize(d.value.value))}`);
  });
}

export const precompile = (assetId: number): Hex =>
  `0x00000000000000000000000000000001${assetId.toString(16).padStart(8, "0")}`;

export const truncatedEvmAccount = (h160: Hex): Hex => `0x45544800${h160.slice(2).toLowerCase()}${"00".repeat(8)}`;

export const placeholderSpoke = (assetId: number): Hex => `0x5b0c${assetId.toString(16).padStart(36, "0")}`;

export const placeholderHub = (assetId: number): Hex => `0x4b0b${assetId.toString(16).padStart(36, "0")}`;

export const placeholderFunder = (): Hex => `0xf0de${"0".repeat(36)}`;

export const isPlaceholder = (address: string, assetId?: number): boolean => {
  const a = address.toLowerCase();
  return (
    a === placeholderFunder() ||
    (assetId !== undefined && (a === placeholderSpoke(assetId) || a === placeholderHub(assetId)))
  );
};
