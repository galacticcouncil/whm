/**
 * 11 MRL assets to exit ("moxit"), calibrated to ~$10 each. Payloads are TEMPLATED from Palo's
 * validated PRIME_TEST_EXIT (probes/payloads.ts) by length-preserving field substitution:
 *   - token  (Moonbeam ERC20, padded32) — global replace, 2 occurrences (batch to[0] + transferTokens arg0)
 *   - amount (uint256 native-decimals)  — global replace, 2 occurrences (approve + transferTokens)
 *   - chain  (wormhole recipient chain) — offset, transferTokens arg2 (0f5287b0-relative)
 *   - recipient (bytes32)               — offset, transferTokens arg3
 * All fields fixed-width ⇒ total call length invariant ⇒ every upstream SCALE/XCM length prefix stays valid.
 * Prices: 2026-07-07 dependency-graph snapshot (test amounts, not exact). Recipients: DRY-RUN placeholders.
 */
import type { Hex } from "viem";
import { PRIME_TEST_EXIT } from "./payloads";

const PRIME_TOKEN = "52b2f622f5676e92dbea3092004eb9ffb85a8d07";
const PRIME_AMT = 1000000000000n; // 0xe8d4a51000, transferTokens+approve arg in PRIME template
const pad = (h: string) => h.replace(/^0x/, "").toLowerCase().padStart(64, "0");

export interface ExitAsset {
  sym: string; id: number; token: string; decimals: number;
  originChain: number; priceUsd: number;
}
// wormhole chain ids: eth 2, solana 1, base 30, sui 21
export const ASSETS: ExitAsset[] = [
  { sym: "DAI",     id: 18,      token: "0x06e605775296e851FF43b4dAa541Bb0984E9D6fD", decimals: 18, originChain: 2,  priceUsd: 1.0    },
  { sym: "WBTC",    id: 19,      token: "0xE57eBd2d67B462E9926e04a8e33f01cD0D64346D", decimals: 8,  originChain: 2,  priceUsd: 61950  },
  { sym: "WETH",    id: 20,      token: "0xab3f0245B83feB11d15AAffeFD7AD465a59817eD", decimals: 18, originChain: 2,  priceUsd: 1740   },
  { sym: "USDC",    id: 21,      token: "0x931715FEE2d06333043d11F658C8CE934aC61D0c", decimals: 6,  originChain: 2,  priceUsd: 1.0    },
  { sym: "USDT",    id: 23,      token: "0xc30E9cA94CF52f3Bf5692aaCF81353a27052c46f", decimals: 6,  originChain: 2,  priceUsd: 1.0    },
  { sym: "jitoSOL", id: 40,      token: "0xe9f9a2e3deae4093c00fbc57b22bb51a4c05ad88", decimals: 9,  originChain: 1,  priceUsd: 104.4  },
  { sym: "PRIME",   id: 43,      token: "0x52b2f622f5676e92dbea3092004eb9ffb85a8d07", decimals: 6,  originChain: 1,  priceUsd: 1.047  },
  { sym: "EURC",    id: 44,      token: "0x3f9610A50630Bc7D4530736942ee2bC9e00E8De8", decimals: 6,  originChain: 30, priceUsd: 1.08   },
  { sym: "sUSDS",   id: 1000745, token: "0xda430218862d3db25de9f61458645dde49a9e9c1", decimals: 18, originChain: 2,  priceUsd: 1.05   },
  { sym: "SOL",     id: 1000752, token: "0x99Fec54a5Ad36D50A4Bba3a41CAB983a5BB86A7d", decimals: 9,  originChain: 1,  priceUsd: 81.3   },
  { sym: "SUI",     id: 1000753, token: "0x484ecce6775143d3335ed2c7bcb22151c53b9f49", decimals: 9,  originChain: 21, priceUsd: 0.746  },
];

/** ~$10 in native-decimal raw units, floored to 8-dp precision (Wormhole trims to 8dp, reverts on dust). */
export function tenDollarRaw(a: ExitAsset): bigint {
  const tokens = 10 / a.priceUsd;
  const raw = BigInt(Math.round(tokens * 1e8)) * 10n ** BigInt(Math.max(0, a.decimals - 8));
  // for <8dp assets, Math.round already gives native raw at 8dp scaled up; for >8dp multiply handles alignment
  return a.decimals >= 8 ? raw : BigInt(Math.round(tokens * 10 ** a.decimals));
}

/**
 * Council-multisig destinations, per Wormhole recipient chain. transferTokens takes a bytes32
 * recipient; encoding differs by chain:
 *   - EVM  (Ethereum 2, Base 30): 20-byte address, LEFT-padded to 32 bytes.
 *   - Solana (1): the recipient is a 32-byte account. For SPL redemption the Wormhole token bridge
 *     credits an **associated token account (ATA)** of the wrapped mint — NOT a wallet pubkey. Each
 *     Solana asset (SOL, jitoSOL, PRIME) has a distinct mint ⇒ a distinct ATA owned by the Squads
 *     vault. Supply either the per-mint ATA (safest) or the vault owner if you rely on
 *     complete_transfer to derive/create the ATA. Base58 → 32 raw bytes (no left-pad).
 *   - Sui (21): 32-byte account/object address.
 * Fill these before any real (non-dry-run) submission. Empty ⇒ resolveRecipient falls back to the
 * labelled dry-run placeholder.
 */
export const COUNCIL: Record<number, string> = {
  2: "0xD557AeAf1e0cB3D226BfF3B7a10C2cdA9dA081E7",  // ⚠️ Safe 4-of-6 — DEPLOYED ON BASE, **NOT on Ethereum yet**. Deploy same address on ETH (Safe cross-chain deterministic) BEFORE redeeming or funds strand. DAI/WBTC/WETH/USDC/USDT/sUSDS
  30: "0xD557AeAf1e0cB3D226BfF3B7a10C2cdA9dA081E7", // Base Safe 4-of-6 (live) — EURC
  1: "",  // Solana Squads vault / ATA (32-byte, base58-decoded) — SOL/jitoSOL/PRIME (see note re: ATA)
  21: "0x9fed34580e448224db25a7ea654460d105d9c6f961d3f6861af1362cfe23c86b", // ⚠️ PROVISIONAL Sui multisig (interim 6 real members + 1 placeholder). Rebuilt w/ new address once cl0w's key lands — re-point before real submission.

};

/** Left-pad a 20-byte EVM address to a bytes32 recipient. */
export const evmRecipient = (addr20: string): string => pad(addr20);

/** DRY-RUN placeholder recipient (bytes32) — recognizable 0xe217<chain><assetId>. */
export function placeholderRecipient(a: ExitAsset): string {
  return pad("0xe217" + a.originChain.toString(16).padStart(4, "0") + a.id.toString(16).padStart(8, "0"));
}

/**
 * Solana (chain 1) needs PER-ASSET recipients: the Wormhole SPL redemption credits the vault's
 * associated token account (ATA) for each mint, not the bare vault. Derived
 * ATA = PDA([vault, TOKEN_PROGRAM, mint], ASSOCIATED_TOKEN_PROGRAM) for vault EJADf… (Squads).
 * (32-byte base58 → stored as hex-less base58; encoded to bytes32 at build time via b58→32.)
 */
export const SOLANA_ATA: Record<string, string> = {
  SOL:     "6H6Y1zwJ8xFFmN7MxQVwnHXHFT4v41VwdhYWDiwF9s24", // wSOL ATA
  jitoSOL: "9Wvdk6JpARzTV869YEkLenJUeCULfEox4PmpRT9i9NiE",
  PRIME:   "EsmJrr2f9oufzJKGDeCbCgYTx6Nv7evpz24L12So2KU6",
};

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58ToHex32(s: string): string {
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(B58.indexOf(c));
  return n.toString(16).padStart(64, "0"); // 32-byte solana pubkey → hex (no 0x)
}

/** Real recipient (bytes32 hex, no 0x) if configured, else the dry-run placeholder. */
export function resolveRecipient(a: ExitAsset): string {
  if (a.originChain === 1) {
    const ata = SOLANA_ATA[a.sym];
    return ata ? b58ToHex32(ata) : placeholderRecipient(a); // solana: 32-byte pubkey, no left-pad
  }
  const c = COUNCIL[a.originChain];
  return c ? pad(c) : placeholderRecipient(a); // evm: left-pad 20→32; sui: already 32
}

/** Template a full PolkadotXcm.send RuntimeCall hex for one asset from the PRIME base. */
export function buildExitPayload(a: ExitAsset, amount: bigint, recipient32: string): Hex {
  let hex = PRIME_TEST_EXIT.slice(2).toLowerCase();
  // 1. token: global replace (2 occurrences: batch to[0] + transferTokens arg0)
  hex = hex.split(pad(PRIME_TOKEN)).join(pad(a.token));
  // 2. amount: global replace (2 occurrences: approve arg1 + transferTokens arg1)
  hex = hex.split(pad(PRIME_AMT.toString(16))).join(pad(amount.toString(16)));
  // 3+4. chain + recipient: offset-based off transferTokens selector 0f5287b0
  const tt = hex.indexOf("0f5287b0"); const base = tt + 8;
  const put = (argIdx: number, val: string) =>
    hex = hex.slice(0, base + argIdx * 64) + pad(val) + hex.slice(base + (argIdx + 1) * 64);
  put(2, a.originChain.toString(16)); // recipientChain
  put(3, recipient32);                // recipient
  return ("0x" + hex) as Hex;
}
