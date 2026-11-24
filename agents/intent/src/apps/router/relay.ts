const RELAY_RPC = "https://solver-relay-v2.chaindefuser.com/rpc";

/** How long to follow a published payout before leaving it to the next pass. */
const SETTLE_TIMEOUT_MS = 120_000;

/**
 * A solver relay JSON-RPC call.
 *
 * @param method Its method.
 * @param params Its single params object.
 * @returns The result.
 * @throws On an RPC error.
 */
async function rpc<T>(method: string, params: unknown): Promise<T> {
  const res = await fetch(RELAY_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [params] }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json()) as { result?: T; error?: unknown };
  if (body.error) throw new Error(`relay ${method}: ${JSON.stringify(body.error)}`);
  return body.result as T;
}

/**
 * Publish a signed delivery or refund — it needs no quote — and follow it until it settles, so the
 * next pass reads the balance it left rather than signing the same payout again.
 *
 * @param signedData The `intent_signed` event's `signed_data`.
 * @returns The intent's hash and its last status.
 * @throws When the relay refuses it.
 */
export async function publish(signedData: unknown): Promise<{ hash: string; status: string }> {
  const p = await rpc<{ status: string; intent_hash?: string; reason?: string }>("publish_intent", {
    quote_hashes: [],
    signed_data: signedData,
  });
  if (!p.intent_hash) throw new Error(`relay refused: ${p.status} ${p.reason ?? ""}`);

  let status = p.status;
  for (const start = Date.now(); Date.now() - start < SETTLE_TIMEOUT_MS; ) {
    await new Promise((r) => setTimeout(r, 3_000));
    status = (await rpc<{ status: string }>("get_status", { intent_hash: p.intent_hash })).status;
    if (status === "SETTLED" || status === "NOT_FOUND_OR_NOT_VALID") break;
  }
  return { hash: p.intent_hash, status };
}
