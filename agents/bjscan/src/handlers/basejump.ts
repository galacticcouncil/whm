import type { LogEvent } from "../db.js";
import { upsertTransfer } from "../db.js";
import type { HandlerMap } from "../processor.js";
import { broadcast } from "../subscribers.js";
import { base } from "../clients.js";
import { BridgeInitiated } from "../resources/basejump.abi.js";

const handlers: HandlerMap = {
  BridgeInitiated: { abi: BridgeInitiated, handle: initiated },
};

async function initiated(ev: LogEvent): Promise<void> {
  const a = ev.args as {
    asset: `0x${string}`;
    amount: bigint;
    fee: bigint;
    destChain: number;
    recipient: `0x${string}`;
    transferSequence: bigint;
    messageSequence: bigint;
  };
  const netAmount = (a.amount - a.fee).toString();
  const id = `init-${ev.chain}-${a.transferSequence}`;

  const tx = await base.getTransaction({ hash: ev.ref.txHash });
  const sender = tx.from;

  const { row, created, previousState } = await upsertTransfer(id, "initiated", {
    source_chain: ev.chain,
    sender,
    source_asset: a.asset,
    recipient: a.recipient,
    gross_amount: a.amount.toString(),
    fee: a.fee.toString(),
    net_amount: netAmount,
    transfer_sequence: a.transferSequence.toString(),
    message_sequence: a.messageSequence.toString(),
    initiated: ev.ref,
  });

  broadcast(
    created
      ? { kind: "created", transfer: row }
      : { kind: "updated", transfer: row, previousState: previousState! },
  );
}

export default handlers;
