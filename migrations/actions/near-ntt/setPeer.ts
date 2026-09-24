import { call, checked } from "@whm/common/near";

import type { NearContext } from "../types";

export type SetPeerParams = NearContext & {
  nttAccount: string;
  chainId: number;
  /** Peer NttManager, 32-byte hex. */
  manager: string;
  /** Peer transceiver — its Wormhole emitter, 32-byte hex. */
  transceiver: string;
  /** The peer token's decimals. */
  decimals: number;
  /** Inbound limit from this peer, in this contract's token units. */
  inboundLimit: string;
};

export type SetPeerResult = {
  txHash: string;
  chainId: string;
  manager: string;
  transceiver: string;
  decimals: string;
  inboundLimit: string;
};

/**
 * Registers a peer on the NEAR NTT contract — its manager, its Wormhole emitter, the precision it
 * trims to — and that peer's inbound limit. Owner-only.
 *
 * @param params Owner wallet, NTT contract account, peer chain, manager, transceiver, decimals, limit
 * @returns The transaction and what was set
 */
export async function setPeer(params: SetPeerParams): Promise<SetPeerResult> {
  const { account, nttAccount, chainId, manager, transceiver, decimals, inboundLimit } = params;

  const outcome = await call(account, nttAccount, "set_peer", {
    chain_id: chainId,
    manager,
    transceiver,
    decimals,
    inbound_limit: inboundLimit,
  });
  checked("set_peer", outcome);

  return {
    txHash: outcome.transaction.hash,
    chainId: String(chainId),
    manager,
    transceiver,
    decimals: String(decimals),
    inboundLimit,
  };
}
