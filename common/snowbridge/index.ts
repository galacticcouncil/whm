export type AssetClass = "rebind" | "merge" | "retire";

// erc20 address on ethereum, or native ether
export type SnowbridgeToken = `0x${string}` | "ETH";

export interface SnowbridgeAsset {
  id: number;
  symbol: string;
  cls: AssetClass;
  token: SnowbridgeToken;
  twin?: number;
}

export const SNOWBRIDGE_ASSETS: SnowbridgeAsset[] = [
  { id: 1000765, symbol: "tBTC", cls: "rebind", token: "0x18084fba666a33d37592fa2633fd49a74dd93a88" },
  { id: 46, symbol: "apyUSD", cls: "rebind", token: "0x38eeb52f0771140d10c4e9a9a72349a329fe8a6a" },
  { id: 34, symbol: "ETH", cls: "rebind", token: "ETH" },
  { id: 1000809, symbol: "wstETH", cls: "rebind", token: "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0" },
  { id: 39, symbol: "PAXG", cls: "rebind", token: "0x45804880de22913dafe09f4980848ece6ecbaf78" },
  { id: 1000766, symbol: "USDC", cls: "merge", twin: 21, token: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" },
  { id: 1000767, symbol: "USDT", cls: "merge", twin: 23, token: "0xdac17f958d2ee523a2206206994597c13d831ec7" },
  { id: 35, symbol: "TRAC", cls: "rebind", token: "0xaa7a9ca87d3694b5755f213b5d04094b8d0f0a6f" },
  { id: 1000624, symbol: "AAVE", cls: "rebind", token: "0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9" },
  { id: 1000794, symbol: "LINK", cls: "rebind", token: "0x514910771af9ca656af840dff83e8264ecf986ca" },
  { id: 1000795, symbol: "SKY", cls: "rebind", token: "0x56072c95faa701256059aa122697b133aded9279" },
  { id: 1000796, symbol: "LDO", cls: "rebind", token: "0x5a98fcbea516cf06857215779fd812ca3bef1b32" },
  { id: 38, symbol: "ENA", cls: "rebind", token: "0x57e114b691db790c35207b2e685d4a43181e6061" },
  { id: 1000625, symbol: "sUSDe", cls: "rebind", token: "0x9d39a5de30e57443bff2a8307a4256c8797a3497" },
  { id: 1000189, symbol: "WETH", cls: "merge", twin: 20, token: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2" },
  { id: 1000851, symbol: "LBTC", cls: "retire", token: "0x8236a87084f8b84306f72007f36f2618a5634494" },
  { id: 41, symbol: "CFG", cls: "retire", token: "0xcccccccccc33d538dbc2ee4feab0a7a1ff4e8a94" },
  { id: 1000190, symbol: "WBTC", cls: "merge", twin: 19, token: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599" },
  { id: 1000626, symbol: "sUSDS", cls: "retire", token: "0xa3931d71877c0e7a3148cb7eb4463524fec27fbd" },
  { id: 45, symbol: "sUSDat", cls: "retire", token: "0xd166337499e176bbc38a1fbd113ab144e5bd2df7" },
];

// existing ethereum hubs of the merge twins
export const TWIN_HUBS: Record<number, `0x${string}`> = {
  19: "0x081b76AC3cFb65DCe93961d66cea44A74EC8Ef28",
  20: "0x283B14B5Dd352e32154Df014EA96834F395E04b6",
  21: "0x447b2c7485A3d6813F8197E605b10BcCD8dd8398",
  23: "0x9fbd9F16cE7Fa17097E91cc36DC1B7b47aDCa9De",
};

export const WETH_ETHEREUM: `0x${string}` = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

export const EMERGENCY_ADMIN: `0x${string}` = "0xaa7e0000000000000000000000000000000aa7e1";

const ETHEREUM = { type: "Ethereum", value: { chain_id: 1n } };

export const ETHER_LOCATION = {
  parents: 2,
  interior: { type: "X1", value: { type: "GlobalConsensus", value: ETHEREUM } },
};

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
