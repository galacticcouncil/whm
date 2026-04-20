import { destination } from "../config.js";
import type { LogEvent } from "../db.js";
import { findByPendingId, findInitiated, upsertTransfer, type TransferState } from "../db.js";
import type { HandlerMap } from "../processor.js";
import { broadcast } from "../subscribers.js";
import {
  PendingTransferFulfilled,
  TransferExecuted,
  TransferQueued,
} from "../resources/landing.abi.js";

const handlers: HandlerMap = {
  TransferExecuted: { abi: TransferExecuted, handle: executed },
  TransferQueued: { abi: TransferQueued, handle: queued },
  PendingTransferFulfilled: { abi: PendingTransferFulfilled, handle: fulfilled },
};

type DeliveryArgs = {
  sourceAsset: `0x${string}`;
  destAsset: `0x${string}`;
  recipient: `0x${string}`;
  amount: bigint;
};

async function executed(ev: LogEvent): Promise<void> {
  const a = ev.args as DeliveryArgs;
  const netAmount = a.amount.toString();
  const matchId = await findInitiated(a.sourceAsset, a.recipient, netAmount);
  const id = matchId ?? orphanId(ev, "exec");

  await apply(id, "completed", ev, a, netAmount);
}

async function queued(ev: LogEvent): Promise<void> {
  const a = ev.args as DeliveryArgs & { id: bigint };
  const netAmount = a.amount.toString();
  const matchId = await findInitiated(a.sourceAsset, a.recipient, netAmount);
  const id = matchId ?? orphanId(ev, "queue");

  await apply(id, "queued", ev, a, netAmount, { pending_id: a.id.toString() });
}

async function fulfilled(ev: LogEvent): Promise<void> {
  const a = ev.args as DeliveryArgs & { id: bigint };
  const matchId = await findByPendingId(a.id.toString());
  const id = matchId ?? orphanId(ev, "fulfill");

  await apply(id, "fulfilled", ev, a, a.amount.toString(), { pending_id: a.id.toString() });
}

async function apply(
  id: string,
  state: TransferState,
  ev: LogEvent,
  a: DeliveryArgs,
  netAmount: string,
  extra: { pending_id?: string } = {},
): Promise<void> {
  const fieldRef =
    state === "completed"
      ? { completed: ev.ref }
      : state === "queued"
        ? { queued: ev.ref }
        : state === "fulfilled"
          ? { fulfilled: ev.ref }
          : {};

  const { row, created, previousState } = await upsertTransfer(id, state, {
    source_chain: id.startsWith("init-") ? id.split("-")[1] : "unknown",
    dest_chain: ev.chain,
    dest_chain_id: destination.chainId,
    source_asset: a.sourceAsset,
    dest_asset: a.destAsset,
    recipient: a.recipient,
    net_amount: netAmount,
    ...fieldRef,
    ...extra,
  });

  broadcast(
    created
      ? { kind: "created", transfer: row }
      : { kind: "updated", transfer: row, previousState: previousState! },
  );
}

function orphanId(ev: LogEvent, kind: string): string {
  return `orphan-${kind}-${ev.chain}-${ev.ref.txHash}-${ev.ref.logIndex}`;
}

export default handlers;
