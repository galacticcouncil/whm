import type { JsonRpcProvider } from "near-api-js";

import type { UtxoChain } from "../chains";

import { view } from "./client";

/** Omni Bridge API — registering the order there is what lets Omni's relayer finalize the deposit. */
const OMNI_API = "https://mainnet.api.bridge.nearone.org/api/v3/utxo/get_user_deposit_address";

/**
 * The API registers each order with a NEAR transaction of its own, which now and then fails on its
 * nonce — a 5xx a retry clears.
 */
const OMNI_ATTEMPTS = 3;
const OMNI_RETRY_MS = 2_000;

/** Hydration's Wormhole chain id — the NTT transfer's `recipient_chain`. */
const HYDRATION = 73;

/**
 * Where a publish that fails after the manager accepted is refunded — the depositor has no NEAR
 * account, so the DAO, registered on each route's token, pays them back.
 */
const REFUND_TO = "hydration.sputnik-dao.near";

export interface Deposit {
  /** Pay the coin here, on its own chain. */
  address: string;
  /** The order the address is derived from — NEAR-side data, never on the coin's chain. */
  order: {
    recipient_id: string;
    safe_deposit: { msg: string };
    refund_address?: string;
  };
}

/**
 * The deposit address for a Hydration recipient: our NTT manager's `TransferMsg` as the order's
 * `safe_deposit.msg`. Registered with the Omni API, and checked against the connector's own view of
 * the same order — the address is a hash over the exact JSON, so a mismatch means the order did not
 * survive the trip and must not be paid.
 *
 * @param provider A NEAR provider.
 * @param chain The chain.
 * @param recipient Hydration EVM address, 20 bytes (or the same left-padded to 32), `0x` hex.
 * @param refundAddress Where a refused deposit goes back to, on the coin's chain — part of the order.
 * @returns The address and the order.
 * @throws When the API fails or disagrees with the connector.
 */
export async function depositAddress(
  provider: JsonRpcProvider,
  chain: UtxoChain,
  recipient: string,
  refundAddress?: string,
): Promise<Deposit> {
  const { connector, manager, omniChain } = chain.deposit;
  const msg = JSON.stringify({ recipient_chain: HYDRATION, recipient, refund_to: REFUND_TO });
  const order: Deposit["order"] = {
    recipient_id: manager,
    safe_deposit: { msg },
    ...(refundAddress ? { refund_address: refundAddress } : {}),
  };

  const body = JSON.stringify({
    chain: omniChain,
    recipient: manager,
    safe_deposit: { msg },
    ...(refundAddress ? { refund_address: refundAddress } : {}),
  });
  let res = await registerOrder(body);
  for (let attempt = 1; res.status >= 500 && attempt < OMNI_ATTEMPTS; attempt++) {
    await new Promise((r) => setTimeout(r, OMNI_RETRY_MS));
    res = await registerOrder(body);
  }
  if (!res.ok) throw new Error(`omni api ${res.status}: ${await res.text()}`);
  const { address } = (await res.json()) as { address: string };

  const expected = await view<string>(provider, connector, "get_user_deposit_address", { deposit_msg: order });
  if (address !== expected) throw new Error(`omni api returned ${address}, connector derives ${expected}`);

  return { address, order };
}

/**
 * Register an order with the Omni API.
 *
 * @param body The request body.
 * @returns The raw response.
 */
function registerOrder(body: string): Promise<Response> {
  return fetch(OMNI_API, { method: "POST", headers: { "Content-Type": "application/json" }, body });
}
