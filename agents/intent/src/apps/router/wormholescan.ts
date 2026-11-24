const WORMHOLESCAN = "https://api.wormholescan.io/api/v1";

/**
 * A signed VAA by its id. Fetched by `chain/emitter/sequence`, never by transaction hash: Hydration
 * nodes do not agree on an EVM transaction's hash.
 *
 * @param id `chain/emitter/sequence`, as scan gives it.
 * @returns The VAA's bytes.
 * @throws While the guardians have not signed it yet.
 */
export async function loadVaa(id: string): Promise<Buffer> {
  const res = await fetch(`${WORMHOLESCAN}/vaas/${id}`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`wormholescan ${res.status} for ${id}`);
  const body = (await res.json()) as { data?: { vaa: string } };
  if (!body.data) throw new Error(`no VAA at ${id} yet`);
  return Buffer.from(body.data.vaa, "base64");
}
