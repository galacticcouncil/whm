import type { PublicClient } from "viem";

import { LogEvent, upsertTransfer } from "../../db";
import { HandlerMap } from "../../processor";
import { broadcast } from "../../subscribers";
import { normalizeRecipient } from "../../utils";

import { BridgeInitiatedEvt } from "./abi";
import { createUtils } from "./utils";

export function basejump(client: PublicClient): HandlerMap {
  const { withBlockTime, getSender } = createUtils(client);

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

    const [sender, ref] = await Promise.all([getSender(ev.ref), withBlockTime(ev.ref)]);

    const { row, created, previousState } = await upsertTransfer(id, "initiated", {
      source_chain: ev.chain,
      sender,
      source_asset: a.asset,
      recipient: normalizeRecipient(a.recipient),
      gross_amount: a.amount.toString(),
      fee: a.fee.toString(),
      net_amount: netAmount,
      transfer_sequence: a.transferSequence.toString(),
      message_sequence: a.messageSequence.toString(),
      initiated: ref,
    });

    broadcast(
      created
        ? { kind: "created", transfer: row }
        : { kind: "updated", transfer: row, previousState: previousState! },
    );
  }

  return {
    BridgeInitiated: { abi: BridgeInitiatedEvt, handle: initiated },
  };
}
