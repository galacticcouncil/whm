import * as anchor from "@coral-xyz/anchor";

import { args } from "@whm/common";

const { PublicKey } = anchor.web3;

const { requiredArg } = args;

async function main() {
  const id = requiredArg("--id");
  const PDA = new PublicKey(id);

  const hex = "0x" + Buffer.from(PDA.toBytes()).toString("hex");

  console.log("AccountId (bytes32):", hex);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
