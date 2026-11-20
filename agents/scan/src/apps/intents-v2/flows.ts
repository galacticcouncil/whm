import { CHAINS } from "../../chains";
import { INTENT_V2 } from "../../deployments";
import { vaaId } from "../../ingest/vaa";
import type { Flow, LogEvent } from "../../types";

import { OrderForwardedEvt, OrderPublishedEvt, OrderSourcedEvt, RelayFeePaidEvt } from "./abi";
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

interface Sourced {
  seq: bigint;
  intentId: bigint;
  assetIn: `0x${string}`;
  amountIn: bigint;
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

/** The router's `intent_signed` event, as far as it is read — one per payload it has signed. */
interface Signed {
  /** `swap`, `deliver` or `refund`. */
  action: string;
  auth_path: string;
  /** The order filled — swaps only. */
  seq: number | null;
  amount: string;
  /** 1Click's deposit account on a swap; the terms' recipient or `refundTo` on a payout. */
  receiver: string;
}

const INTENT_SIGNED = { standard: "whm-intent-router", event: "intent_signed" };

const transfer = (a: { transferSequence: bigint }) => a.transferSequence.toString();

/**
 * An order, from the dispatcher that publishes it on Hydration, through the forwarder that deposits
 * its ETH on Ethereum, to the router's swap of it on NEAR.
 *
 * Keyed on the order's `seq` — the NTT message id of its transfer, which is the `transferSequence`
 * the forwarder names and the `seq` the router's swap names. Every order of one set of terms shares
 * their `auth_path`, which is how the terms still in play are read back (`db.ts`).
 *
 * `swapped` is the router signing the order's swap; the payout is the terms', not the order's — see
 * `payouts`.
 */
export const orders: Flow = {
  name: "orders-v2",
  table: "intent_v2_orders",
  key: { column: "seq", type: "BIGINT" },
  states: { published: 0, forwarded: 1, swapped: 2 },
  requires: { forwarded: "published", swapped: "published" },
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
    /** 1Click's deposit account for the swap — its explorer's link to the execution. */
    swap_deposit: "TEXT",
    /** The ICE intent behind the order, when `execute` placed it. */
    intent_id: "NUMERIC",
    /** The Hydration asset the user sold for the order's WETH — its EVM address, as ICE names it — and how much. */
    asset_in: "TEXT",
    amount_in: "NUMERIC",
    published: "JSONB",
    forwarded: "JSONB",
    swapped: "JSONB",
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
      // Same transaction as the publish, from `execute` only: what the ICE trade sold for the WETH.
      role: "intent-dispatcher",
      abi: OrderSourcedEvt,
      state: "published",
      key: (a: Sourced) => a.seq.toString(),
      patch: (a: Sourced) => ({
        intent_id: a.intentId.toString(),
        // A precompile's or, for an ERC20-type asset, its contract's; the API resolves it to the id.
        asset_in: a.assetIn.toLowerCase(),
        amount_in: a.amountIn.toString(),
      }),
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
    {
      // The router signs the order's swap. A quote re-signed inside the order's price window lands
      // on the same row, the later one standing.
      role: "intent-router",
      near: INTENT_SIGNED,
      state: "swapped",
      key: (a: Signed) => (a.action === "swap" && a.seq != null ? String(a.seq) : null),
      patch: (a: Signed, ev: LogEvent) => ({
        swap_deposit: a.receiver,
        swapped: ev.ref,
      }),
    },
  ],
};

/**
 * The router's payouts: a delivery of `A`'s destination asset to the terms' recipient, or a refund of
 * its ETH to `refundTo`.
 *
 * A table of its own, keyed by the signing log, rather than a leg on the order: a payout is the
 * terms', not one order's — a DCA's deliveries batch the output of several. An order page shows the
 * first payout of its terms after its own swap.
 *
 * Only what the terms do not say is kept: where it goes and in what asset are the terms' — joined
 * through `auth_path` from `intent_v2_orders`. The signature is NEAR's; where the asset then lands — a
 * Zcash transaction for a withdrawal — is filled in by the payout poller (`payouts.ts`).
 */
export const payouts: Flow = {
  name: "payouts-v2",
  table: "intent_v2_payouts",
  key: { column: "id", type: "TEXT" },
  states: { delivered: 0, refunded: 0 },
  columns: {
    auth_path: "TEXT",
    /** What left `A`: the destination asset delivered, or the ETH refunded. */
    amount: "NUMERIC",
    /** The payout's transaction on the recipient's own chain, once found. */
    dest_tx: "TEXT",
    /** What arrived there, in that chain's smallest units — the amount less the bridge's fee. */
    dest_amount: "NUMERIC",
    /** When it arrived, unix ms. */
    dest_at: "BIGINT",
    signed: "JSONB",
  },
  indexes: [
    `CREATE INDEX IF NOT EXISTS idx_intent_v2_payouts_auth_path ON intent_v2_payouts (auth_path);`,
  ],
  legs: (["deliver", "refund"] as const).map((action) => ({
    role: "intent-router",
    near: INTENT_SIGNED,
    state: action === "deliver" ? "delivered" : "refunded",
    key: (a: Signed, ev: LogEvent) => (a.action === action ? `${ev.ref.txHash}:${ev.ref.logIndex}` : null),
    patch: (a: Signed, ev: LogEvent) => ({
      auth_path: a.auth_path,
      amount: a.amount,
      signed: ev.ref,
    }),
  })),
};
