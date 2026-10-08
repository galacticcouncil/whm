import { isAddress, type Address } from "viem";

/**
 * Env holds only what changes between deployments: the signing key, the RPCs, and the infra
 * endpoints. Everything else an app needs — routes, addresses, retry policy — is a constant in
 * that app's `config.ts`.
 */

/**
 * Read a required env var.
 *
 * @param name Variable name.
 * @returns Its value.
 * @throws When unset or empty.
 */
export function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env ${name}`);
  return v;
}

/**
 * Read a required env var that must hold an EVM address.
 *
 * @param name Variable name.
 * @returns The checksummed-or-not address, validated.
 * @throws When unset or not an address.
 */
export function reqAddress(name: string): Address {
  const v = req(name);
  if (!isAddress(v)) throw new Error(`${name} is not a valid address: ${v}`);
  return v;
}

/**
 * Read an optional env var with a fallback.
 *
 * @param name Variable name.
 * @param fallback Value to use when unset.
 * @returns Either the set value or the fallback.
 */
export function opt(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

/**
 * Read an optional numeric env var with a fallback.
 *
 * @param name Variable name.
 * @param fallback Value to use when unset.
 * @returns The parsed number.
 */
export function optNum(name: string, fallback: number): number {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : Number(v);
}

/**
 * Parse and validate a 32-byte hex private key read from `name`, normalizing the `0x` prefix.
 *
 * @param name Env var the raw value came from, for the error message only.
 * @param raw The env var's raw value.
 * @returns The key, 0x-prefixed, lowercased.
 * @throws When not 32 bytes of hex.
 * @remarks viem requires the prefix where ethers did not, so bare-hex keys carried over from an
 *          earlier deployment are accepted and normalized rather than rejected at startup.
 */
function parsePrivateKey(name: string, raw: string): `0x${string}` {
  const hex = raw.startsWith("0x") || raw.startsWith("0X") ? raw.slice(2) : raw;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`${name} is not a 32-byte hex private key (got ${hex.length} hex chars)`);
  }
  return `0x${hex.toLowerCase()}`;
}

/**
 * The process's signing key. One name across every app — services differ by the value, which is
 * what keeps the NTT and oracle wallets on separate nonces.
 *
 * @returns The key, 0x-prefixed.
 * @throws When unset, or not 32 bytes of hex.
 */
export function privateKey(): `0x${string}` {
  return parsePrivateKey("PRIVKEY", req("PRIVKEY").trim());
}

/**
 * Base's own signing key, from `PRIVKEY_BASE` — a name distinct from `PRIVKEY`, so that a process
 * holding both a Base client and a client for another chain (built via `privateKey()`) does not
 * sign both from one account unless both variables are given the same key; nothing compares the
 * two values. The separation is for funds and blast radius: the Base wallet's balance and key are
 * not a Hydration wallet's. A nonce has nothing to do with it, since nonces are per chain. It does
 * not fall back to `PRIVKEY` when unset: a silent fallback here would defeat that.
 *
 * @returns The key, 0x-prefixed.
 * @throws When unset, or not 32 bytes of hex.
 */
export function privateKeyBase(): `0x${string}` {
  return parsePrivateKey("PRIVKEY_BASE", req("PRIVKEY_BASE").trim());
}

/**
 * Read a chain's RPC from `RPC_<CHAIN>`, matching the migrations' env convention.
 *
 * @param chain Chain name, lowercase.
 * @param fallback Public endpoint to use when unset.
 * @returns The RPC URL.
 */
export function rpc(chain: string, fallback: string): string {
  return opt(`RPC_${chain.toUpperCase()}`, fallback);
}

/**
 * A chain's cold-start floor, from `FROM_SEQ_<CHAIN>`.
 *
 * Consulted only while the app's namespace has no `safeSequence` in Redis — from the first run on,
 * the engine resumes from its own cursor and this is ignored. Set it before a namespace's first run
 * to skip a backlog the app was never meant to relay.
 *
 * @param chain Chain name, lowercase.
 * @param fallback Sequence to start from when unset.
 * @returns The floor.
 */
export function fromSeq(chain: string, fallback = 0n): bigint {
  return BigInt(opt(`FROM_SEQ_${chain.toUpperCase()}`, fallback.toString()));
}

/**
 * Where a low/exhausted-gas alert goes, and when it fires. Both are env because an on-call operator
 * raises the threshold against a wallet that is spending faster than it is topped up, and waiting on
 * a rebuild to do it is no use.
 *
 * @returns Webhook (omit to log only) and the multiple of one submission's cost to warn below.
 */
export function alerts() {
  return {
    discordWebhook: process.env.DISCORD_WEBHOOK_URL,
    warnMultiplier: BigInt(opt("GAS_WARN_MULTIPLIER", "50")),
  };
}

/** Shared across every app: the spy stream and the Redis the engine keeps its state in. */
export function engineConfig() {
  return {
    spyEndpoint: opt("SPY_ENDPOINT", "localhost:7073"),
    redis: {
      host: opt("REDIS_HOST", "localhost"),
      port: optNum("REDIS_PORT", 6379),
    },
  };
}

export type EngineConfig = ReturnType<typeof engineConfig>;
