import { CHAINS } from "../../chains";
import { INTENT_V2 } from "../../deployments";
import { vaaId } from "../../ingest/vaa";
import type { Flow, LogEvent } from "../../types";

import { OrderForwardedEvt, OrderPublishedEvt, RelayFeePaidEvt } from "./abi";
import { decodeTerms } from "./terms";

interface Published {
  authPath: `0x${string}`;
  seq: bigint;
  caller: `0x${string}`;
  depositAddress: `0x${string}`;
  amount: bigint;
  outPerIn: bigint;
  messageSequence: bigint;
  terms: `0x${string}`;
}

interface Forwarded {
  transferSequence: bigint;
  depositAddress: `0x${string}`;
  amount: bigint;
}

interface FeePaid {
  transferSequence: bigint;
  relayer: `0x${string}`;
  fee: bigint;
}

const transfer = (a: { transferSequence: bigint }) => a.transferSequence.toString();

/**
 * An order, from the dispatcher that publishes it on Hydration to the forwarder that deposits its
 * ETH to POA on Ethereum.
 *
 * Keyed on the order's `seq` — the NTT message id of its transfer, which is the `transferSequence`
 * the forwarder names. Every order of one set of terms shares their `auth_path`, which is how the
 * terms still in play are read back (`db.ts`).
 *
 * `forwarded` is the end of what this flow sees. What follows happens on NEAR.
 */
export const orders: Flow = {
  name: "orders-v2",
  table: "intent_v2_orders",
  key: { column: "seq", type: "BIGINT" },
  states: { published: 0, forwarded: 1 },
  requires: { forwarded: "published" },
  columns: {
    /** keccak256 of the terms — the MPC derivation path, and the account `A` the order funds. */
    auth_path: "TEXT",
    caller: "TEXT",
    deposit_address: "TEXT",
    /** The least ETH `A` receives, wei. */
    amount: "NUMERIC",
    out_per_in: "NUMERIC",
    /** The dispatcher's Wormhole sequence for the order message. */
    message_sequence: "BIGINT",
    /** The order message's VAA id — what the router's `swap` takes. */
    order_vaa: "TEXT",
    /** The encoded terms, as emitted — what the router's calls take. */
    terms: "TEXT",
    owner: "TEXT",
    /** Unix seconds. */
    deadline: "BIGINT",
    recipient_kind: "SMALLINT",
    refund_to: "TEXT",
    destination_asset: "TEXT",
    recipient: "TEXT",
    forwarded_amount: "NUMERIC",
    relay_fee: "NUMERIC",
    relayer: "TEXT",
    published: "JSONB",
    forwarded: "JSONB",
  },
  indexes: [
    `CREATE INDEX IF NOT EXISTS idx_intent_v2_orders_auth_path ON intent_v2_orders (auth_path);`,
    `CREATE INDEX IF NOT EXISTS idx_intent_v2_orders_caller ON intent_v2_orders (caller);`,
    `CREATE INDEX IF NOT EXISTS idx_intent_v2_orders_deadline ON intent_v2_orders (deadline);`,
    `CREATE INDEX IF NOT EXISTS idx_intent_v2_orders_published ON intent_v2_orders (((published->>'blockTimestamp')::numeric) DESC);`,
  ],
  legs: [
    {
      role: "intent-dispatcher",
      abi: OrderPublishedEvt,
      state: "published",
      key: (a: Published) => a.seq.toString(),
      patch: (a: Published, ev: LogEvent) => {
        const t = decodeTerms(a.terms);
        return {
          auth_path: a.authPath.toLowerCase(),
          caller: a.caller.toLowerCase(),
          deposit_address: a.depositAddress.toLowerCase(),
          amount: a.amount.toString(),
          out_per_in: a.outPerIn.toString(),
          message_sequence: a.messageSequence.toString(),
          order_vaa: vaaId(CHAINS[ev.chain].wormholeId, INTENT_V2.dispatcher, a.messageSequence),
          terms: a.terms.toLowerCase(),
          ...(t && {
            owner: t.owner.toLowerCase(),
            deadline: t.deadline.toString(),
            recipient_kind: t.recipientKind,
            refund_to: t.refundTo.toLowerCase(),
            destination_asset: t.destinationAsset,
            recipient: t.recipient,
          }),
          published: ev.ref,
        };
      },
    },
    {
      role: "intent-forwarder",
      abi: OrderForwardedEvt,
      state: "forwarded",
      key: transfer,
      patch: (a: Forwarded, ev: LogEvent) => ({
        forwarded_amount: a.amount.toString(),
        forwarded: ev.ref,
      }),
    },
    {
      // Same transaction as the forward, so the state it claims is the same one — it carries the
      // fee, it does not move the order along.
      role: "intent-forwarder",
      abi: RelayFeePaidEvt,
      state: "forwarded",
      key: transfer,
      patch: (a: FeePaid) => ({
        relay_fee: a.fee.toString(),
        relayer: a.relayer.toLowerCase(),
      }),
    },
  ],
};
