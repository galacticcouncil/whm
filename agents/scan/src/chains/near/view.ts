import { FASTNEAR_RPC } from "./consts";

const RPC = (process.env.RPC_NEAR || FASTNEAR_RPC).replace(/\/$/, "");

/**
 * A NEAR contract view at final finality, through the JSON-RPC.
 *
 * @param account The contract
 * @param method Its view method
 * @param args Its JSON arguments
 * @returns The method's JSON result
 * @throws On an RPC or contract error
 */
export async function view<T>(account: string, method: string, args: Record<string, unknown>): Promise<T> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: account,
        method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json()) as { result?: { result?: number[]; error?: string }; error?: unknown };
  const result = body.result?.result;
  if (!result) throw new Error(`${account}.${method}: ${JSON.stringify(body.error ?? body.result?.error)}`);
  return JSON.parse(Buffer.from(result).toString()) as T;
}
