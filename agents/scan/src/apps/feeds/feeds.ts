import { ORACLE } from "../../deployments";

/** One relayed oracle: what it is, where it comes from, and what it writes on arrival. */
export interface Feed {
  /** What a page addresses it by. */
  id: string;
  symbol: string;
  /** As the payload carries it — `keccak256(symbol)` from an EVM emitter, a mint from Solana's. */
  assetId: `0x${string}`;
  /** The chain its emitter runs on — a key of `ORACLE`. */
  source: keyof typeof ORACLE;
  /** A price is in USD; a rate is in the underlying it converts to. */
  kind: "price" | "rate";
  unit: string;
  /** What the emitter reads, in a few words. */
  reads: string;
  /** The oracle its receiver writes. */
  oracle: string;
  /** Hydration asset id, which the registry keys icons by; null where it has none. */
  icon: number | null;
}

/**
 * Every feed the relays carry, from deployments/prod/oracle-relay-<chain>.json — the asset ids its
 * `register-*@emitter` steps bound, and the oracle its latest `set-*@receiver` step pointed at.
 */
export const FEEDS: Feed[] = [
  {
    id: "wsteth",
    symbol: "wstETH",
    assetId: "0x3725f7650a1fc235623c67881a5755db6c97d7575eddd7351396f0b26fe79334",
    source: "ethereum",
    kind: "rate",
    unit: "stETH",
    reads: "stEthPerToken() on wstETH",
    oracle: "0xBE6B91cCb5b41e68426Dcb584830A360093c2775",
    icon: null,
  },
  {
    id: "apyusd",
    symbol: "apyUSD",
    assetId: "0xde11c6e5fbb09ebf287fceb58deeb4a0e34ccb69e2deeb25dfe46ad04e35a5a8",
    source: "ethereum",
    kind: "rate",
    unit: "apxUSD",
    reads: "convertToAssets(1e18) on apyUSD",
    oracle: "0x80FaaC4Da72FCcABDa5B276D9A931252D6242Caf",
    icon: null,
  },
  {
    id: "sol",
    symbol: "SOL",
    assetId: "0x069b8857feab8184fb687f634618c035dac439dc1aeb3b5598a0f00000000001",
    source: "solana",
    kind: "price",
    unit: "USD",
    reads: "Kamino Scope, price #1",
    oracle: "0xf832dc4268Ac29C9C0B16De1784382BEee801Fb8",
    icon: 1_000_752,
  },
  {
    id: "jitosol",
    symbol: "JitoSOL",
    assetId: "0xfcd141e9832caf10ad917495ca0f271b5b293cd47027ea737007ed40eb39a0bd",
    source: "solana",
    kind: "rate",
    unit: "SOL",
    reads: "Jito stake pool, lamports per pool token",
    oracle: "0x64b7BbAC63E5aDcA0ec35C4AEBf9937Fc1d79C1D",
    icon: 40,
  },
  {
    id: "prime",
    symbol: "PRIME",
    assetId: "0x26759f460ee5f743ed66d27c8f2a5623bf39d53ed575955320661e6e13e0e3da",
    source: "solana",
    kind: "price",
    unit: "USD",
    reads: "Kamino Scope, price #383",
    oracle: "0x09221057Cf7E75953D199FB319E606972A6A82Cd",
    icon: 43,
  },
  {
    id: "spy",
    symbol: "SPY",
    assetId: "0xcea23e8f56b5ac447ac08d57e0808e35f468a65f29bb659b3d48934481e7c67a",
    source: "robinhood",
    kind: "price",
    unit: "USD",
    reads: "Chainlink SPY/USD",
    oracle: "0x802893C9CDD5AaC833E52783DF39e572fe8f8538",
    icon: 1_001_356,
  },
  {
    id: "hdx",
    symbol: "HDX",
    assetId: "0x8f515bbfa43ff773ef7c6c53cb11b1c7ead38052b30f6a928cc96c552714ca38",
    source: "hydration",
    kind: "price",
    unit: "USD",
    reads: "EMA oracle, USDT/HDX over 10 minutes",
    oracle: "0xD1a2198CBbC7cbfB602DF581D8614eD31682901D",
    icon: 0,
  },
];

/**
 * A feed by its page id.
 *
 * @param id `Feed.id`.
 */
export const feed = (id: string) => FEEDS.find((f) => f.id === id) ?? null;
