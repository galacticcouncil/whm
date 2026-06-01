/**
 * Test treasury proposal to fund BasejumpLanding with 10k EURC on a Chopsticks fork.
 *
 * Prerequisites:
 *   npx @acala-network/chopsticks --endpoint wss://rpc.helikon.io/hydradx --port 8000
 *
 * Usage:
 *   npx tsx scripts/treasury/test-fund-landing.ts
 */

import { ApiPromise, WsProvider, Keyring } from "@polkadot/api";
import { blake2AsHex } from "@polkadot/util-crypto";
import type { FrameSupportPreimagesBounded } from "@polkadot/types/lookup";

const CHOPSTICKS_URL = "ws://localhost:8000";
const LANDING_ACCOUNT =
  "0x4554480070e9b12c3b19cb5f0e59984a5866278ab69df9760000000000000000";
const EURC_ASSET_ID = 44;
const FUND_AMOUNT = 10_000_000_000n; // 10k EURC (6 decimals)

async function moveScheduledCallTo(
  api: ApiPromise,
  blockCounts: number,
  verifier: (call: FrameSupportPreimagesBounded) => boolean,
) {
  const blockNumber = (await api.rpc.chain.getHeader()).number.toNumber();
  const agenda = await api.query.scheduler.agenda.entries();
  for (const agendaEntry of agenda) {
    for (const scheduledEntry of agendaEntry[1]) {
      if (scheduledEntry.isSome && verifier(scheduledEntry.unwrap().call)) {
        await api.rpc(
          "dev_setStorage" as any,
          [
            [agendaEntry[0]],
            [
              await api.query.scheduler.agenda.key(blockNumber + blockCounts),
              agendaEntry[1].toHex(),
            ],
          ] as any,
        );
        if (scheduledEntry.unwrap().maybeId.isSome) {
          const id = scheduledEntry.unwrap().maybeId.unwrap().toHex();
          const lookup = await api.query.scheduler.lookup(id);
          if (lookup.isSome) {
            const lookupKey = await api.query.scheduler.lookup.key(id);
            const fastLookup = api.registry.createType("Option<(u32,u32)>", [
              blockNumber + blockCounts,
              0,
            ]);
            await api.rpc(
              "dev_setStorage" as any,
              [[lookupKey, fastLookup.toHex()]] as any,
            );
          }
        }
        return;
      }
    }
  }
  throw new Error("No scheduled call found");
}

async function main() {
  const api = await ApiPromise.create({
    provider: new WsProvider(CHOPSTICKS_URL),
    noInitWarn: true,
  });

  const keyring = new Keyring({ type: "sr25519" });
  const alice = keyring.addFromUri("//Alice");

  const block = (await api.rpc.chain.getHeader()).number.toNumber();
  console.log(`Connected to chopsticks fork at block #${block}`);

  // Check initial balance
  const balanceBefore = await api.query.tokens.accounts(
    LANDING_ACCOUNT,
    EURC_ASSET_ID,
  );
  const freeBefore = (balanceBefore as any).free.toBigInt();
  console.log(`\nLanding EURC balance before: ${Number(freeBefore) / 1e6}`);

  // Build proposal: dispatcher.dispatchAsTreasury(currencies.transfer(...))
  const innerCall = api.tx.currencies.transfer(
    LANDING_ACCOUNT,
    EURC_ASSET_ID,
    FUND_AMOUNT,
  );
  const proposal = api.tx.dispatcher.dispatchAsTreasury(innerCall);
  const proposalIndex = (
    await api.query.referenda.referendumCount()
  ).toNumber();

  console.log(`\nSubmitting preimage + referendum #${proposalIndex}...`);

  // Submit preimage + referendum
  await new Promise<void>(async (resolve, reject) => {
    const unsub = await api.tx.utility
      .batchAll([
        api.tx.preimage.notePreimage(proposal.method.toHex()),
        api.tx.referenda.submit(
          { System: "Root" } as any,
          {
            Lookup: {
              Hash: proposal.method.hash.toHex(),
              len: proposal.method.encodedLength,
            },
          },
          { At: 0 },
        ),
      ])
      .signAndSend(alice, (status: any) => {
        if (status.blockNumber) {
          unsub();
          if (status.dispatchError) {
            reject(
              new Error("Failed to submit: " + status.dispatchError.toString()),
            );
          } else {
            resolve();
          }
        }
      });
  });

  console.log("Referendum submitted, fast-tracking...");

  // Fast-track: manipulate referendum storage to pass immediately
  const totalIssuance = (await api.query.balances.totalIssuance()).toBigInt();
  const referendumKey =
    api.query.referenda.referendumInfoFor.key(proposalIndex);
  const proposalBlockTarget = (
    await api.rpc.chain.getHeader()
  ).number.toNumber();

  const callHash = proposal.method.hash.toHex();

  const fastProposalData = {
    ongoing: {
      ...(
        await api.query.referenda.referendumInfoFor(proposalIndex)
      )
        .unwrap()
        .asOngoing.toJSON(),
      enactment: { after: 0 },
      deciding: {
        since: proposalBlockTarget - 1,
        confirming: proposalBlockTarget - 1,
      },
      tally: {
        ayes: totalIssuance - 1n,
        nays: 0,
        support: totalIssuance - 1n,
      },
      alarm: [proposalBlockTarget + 1, [proposalBlockTarget + 1, 0]],
    },
  };

  let fastProposal;
  try {
    fastProposal = api.registry.createType(
      "Option<PalletReferendaReferendumInfo>",
      fastProposalData,
    );
  } catch {
    fastProposal = api.registry.createType(
      "Option<PalletReferendaReferendumInfoConvictionVotingTally>",
      fastProposalData,
    );
  }

  await api.rpc(
    "dev_setStorage" as any,
    [[referendumKey, fastProposal.toHex()]] as any,
  );
  console.log("Referendum storage overridden");

  // Reschedule nudgeReferendum to next block
  await moveScheduledCallTo(api, 1, (call) => {
    if (!call.isInline) return false;
    const callData = api.createType("Call", call.asInline.toHex());
    return (
      callData.method === "nudgeReferendum" &&
      (callData.args[0] as any).toNumber() === proposalIndex
    );
  });
  console.log("Rescheduled nudgeReferendum");

  await api.rpc("dev_newBlock" as any, { count: 1 } as any);
  console.log(`Block #${(await api.rpc.chain.getHeader()).number.toNumber()}`);

  // Reschedule the actual proposal execution
  await moveScheduledCallTo(api, 1, (call) =>
    call.isLookup
      ? call.asLookup.toHex() === callHash
      : call.isInline
        ? blake2AsHex(call.asInline.toHex()) === callHash
        : call.asLegacy.toHex() === callHash,
  );
  console.log("Rescheduled proposal execution");

  await api.rpc("dev_newBlock" as any, { count: 1 } as any);
  console.log(`Block #${(await api.rpc.chain.getHeader()).number.toNumber()}`);

  // Verify
  const balanceAfter = await api.query.tokens.accounts(
    LANDING_ACCOUNT,
    EURC_ASSET_ID,
  );
  const freeAfter = (balanceAfter as any).free.toBigInt();

  console.log(`\nLanding EURC balance after: ${Number(freeAfter) / 1e6}`);
  console.log(`Change: +${Number(freeAfter - freeBefore) / 1e6} EURC`);

  if (freeAfter >= freeBefore + FUND_AMOUNT) {
    console.log("\n✓ Treasury proposal executed successfully");
  } else {
    console.log("\n✗ Balance did not increase as expected");
    process.exit(1);
  }

  await api.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
