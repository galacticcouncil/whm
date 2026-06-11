/**
 * Poll Wormholescan for a signed VAA and return it as `0x`-hex.
 *
 * Only resolves on real networks where Guardians observe the source chain (mainnet/testnet) —
 * a bare local fork never produces a signed VAA. Pass `apiKey` (WORMHOLE_API_KEY) to avoid
 * the anonymous rate limit.
 *
 * @param emitterChain Wormhole chain id of the emitter (e.g. 16 = Moonbeam, 2 = Ethereum)
 * @param emitterAddr  32-byte emitter address as 64 hex chars, no `0x` (Wormhole format)
 * @param sequence     message sequence from the emitter's LogMessagePublished
 */
export async function fetchVaaHex(
  emitterChain: number,
  emitterAddr: string,
  sequence: bigint,
  apiKey?: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<`0x${string}`> {
  const { timeoutMs = 5 * 60 * 1000, intervalMs = 5000 } = opts;
  const url = `https://api.wormholescan.io/api/v1/vaas/${emitterChain}/${emitterAddr}/${sequence}`;
  const headers = apiKey ? { "X-API-KEY": apiKey } : undefined;
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    const res = await fetch(url, { headers });
    if (res.ok) {
      const json = (await res.json()) as { data?: { vaa?: string } };
      if (json?.data?.vaa) {
        return `0x${Buffer.from(json.data.vaa, "base64").toString("hex")}` as `0x${string}`;
      }
    }
    console.log(`  …waiting for VAA (attempt ${attempt})`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for VAA ${emitterChain}/${emitterAddr}/${sequence}`);
}
