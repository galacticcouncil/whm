import { parseAbi, type Address, type PublicClient } from "viem";

import log from "../../logger";

const coreAbi = parseAbi([
  "function getCurrentGuardianSetIndex() view returns (uint32)",
  "function getGuardianSet(uint32 index) view returns ((address[] keys, uint32 expirationTime))",
]);

/** 19 guardians, quorum 13. Used only when the core contract cannot be read. */
const FALLBACK_QUORUM = 13;

/** Rotations are rare and a stale value only misses by a signature or two. */
const TTL_MS = 60 * 60_000;

/**
 * How many signatures a VAA carries, read from the live guardian set.
 *
 * This is the one input to the envelope that genuinely moves: on a rotation the calldata term
 * follows it. (The execution constant does not — see `gas.ts`.)
 */
export class GuardianQuorum {
  private cached?: { value: number; at: number };
  private inflight?: Promise<number>;

  constructor(
    private readonly client: PublicClient,
    private readonly core: Address,
  ) {}

  /**
   * The current quorum, `⌊2n/3⌋+1` over the active guardian set.
   *
   * @returns The signature count, falling back to 13 when the core contract cannot be read — a
   *          quote built on a slightly wrong envelope beats no quote at all.
   */
  async get(): Promise<number> {
    if (this.cached && Date.now() - this.cached.at < TTL_MS) return this.cached.value;
    this.inflight ??= this.read().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async read(): Promise<number> {
    try {
      const index = await this.client.readContract({
        address: this.core,
        abi: coreAbi,
        functionName: "getCurrentGuardianSetIndex",
      });
      const set = await this.client.readContract({
        address: this.core,
        abi: coreAbi,
        functionName: "getGuardianSet",
        args: [index],
      });
      const n = set.keys.length;
      if (n === 0) throw new Error(`guardian set ${index} is empty`);

      const quorum = Math.floor((n * 2) / 3) + 1;
      if (quorum !== this.cached?.value) {
        log.info(`guardian set ${index}: ${n} keys, quorum ${quorum}`);
      }
      this.cached = { value: quorum, at: Date.now() };
      return quorum;
    } catch (e) {
      log.warn(`guardian set read failed, assuming quorum ${FALLBACK_QUORUM}: ${(e as Error).message}`);
      // Cached like a real read so a broken RPC does not mean a call on every quote.
      this.cached = { value: FALLBACK_QUORUM, at: Date.now() };
      return FALLBACK_QUORUM;
    }
  }
}
