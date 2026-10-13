import { concat, keccak256, pad, toHex, type Hex } from "viem";
import { sign } from "viem/accounts";

import { args } from "@whm/common";
import { accountHash } from "@whm/common/near";

import { FORK_GUARDIAN_PK } from "./fork";

const { optionalArg, requiredArg } = args;

/** Wormhole chain ids. */
const NEAR = 15;
const HYDRATION = 73;

/**
 * Fork only: prints a Hydration → NEAR NTT VAA signed by the fork guardian — what the Hydration
 * NttManager + transceiver would emit — for `complete.ts --vaa`. The manager and transceiver
 * default to the ones `migrations/envs/fork/near-ntt-near.env` peers with.
 *
 * Usage: tsx forkVaa.ts --contract <ntt> --recipient <account> --amount <8-dp units> --sequence <n>
 *                       [--manager <0x…>] [--transceiver <0x…>]
 */
async function main(): Promise<void> {
  const contract = requiredArg("--contract");
  const recipient = requiredArg("--recipient");
  const amount = BigInt(requiredArg("--amount"));
  const sequence = BigInt(requiredArg("--sequence"));
  const manager = (optionalArg("--manager") ?? "0x5b1334885320cFd7158760256c7bD0Af58006b09") as Hex;
  const transceiver = (optionalArg("--transceiver") ?? "0x5e875F689EA8dd25e11a69cfb6C9f844C4b3B207") as Hex;

  const h = (x: string) => `0x${x}` as Hex;
  const u16 = (n: number) => toHex(n, { size: 2 });
  const len = (b: Hex) => u16((b.length - 2) / 2);

  // NativeTokenTransfer — decimals before amount on the wire.
  const transfer = concat([
    "0x994E5454",
    toHex(8, { size: 1 }),
    toHex(amount, { size: 8 }),
    pad("0x07"),
    h(accountHash(recipient)),
    u16(NEAR),
  ]);
  const managerMessage = concat([pad(toHex(sequence)), pad("0x09"), len(transfer), transfer]);
  const payload = concat([
    "0x9945FF10",
    pad(manager),
    h(accountHash(contract)),
    len(managerMessage),
    managerMessage,
    u16(0),
  ]);
  const body = concat([
    toHex(0, { size: 4 }), // timestamp
    toHex(0, { size: 4 }), // nonce
    u16(HYDRATION),
    pad(transceiver),
    toHex(sequence, { size: 8 }),
    toHex(200, { size: 1 }),
    payload,
  ]);

  const sig = await sign({ hash: keccak256(keccak256(body)), privateKey: FORK_GUARDIAN_PK });
  // v1, guardian set 0, one signature from guardian index 0.
  const vaa = concat(["0x01", toHex(0, { size: 4 }), "0x01", "0x00", sig.r, sig.s, toHex(sig.yParity!, { size: 1 }), body]);
  console.log(vaa);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
