export const SOLANA = { name: "solana", wormholeId: 1 } as const;

/** Solana's public RPC — rate-limited, but NTT here is a few transactions a day; `RPC_SOLANA_HTTP` overrides it. */
export const SOLANA_RPC = "https://api.mainnet-beta.solana.com";

/** `getSignaturesForAddress`'s page size, which is also its cap. */
export const SIGNATURE_PAGE = 1_000;

/** `getMultipleAccounts`' cap. */
export const ACCOUNT_BATCH = 100;

/** Slots per top-level instruction in a transaction's log index: its position × this + the inner's. */
export const PER_INSTRUCTION = 1_000;

/** The token programs a release pays out through. */
export const TOKEN_PROGRAMS = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
]);

/** SPL token instructions that move or mint: `Transfer`, `MintTo`, `TransferChecked`, `MintToChecked`. */
export const TOKEN_PAYOUTS = new Set([3, 7, 12, 14]);

/** The Wormhole core's `PostMessage` and `PostMessageUnreliable`, each logging `Sequence: <n>`. */
export const CORE_POSTS = new Set([1, 8]);
