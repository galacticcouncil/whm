import { args } from "@whm/common";

import { utils } from "../lib";

const { requiredArg } = args;
const { mnemonicToAccountByAddress } = utils;

async function main() {
  const seed = requiredArg("--seed");
  const address = requiredArg("--address");
  const account = mnemonicToAccountByAddress(seed, address);
  const pk = account.getHdKey().privateKey;
  if (!pk) {
    throw Error("Invalid parameters");
  }
  const pkHex = "0x" + Buffer.from(pk).toString("hex");
  console.log("Private key:", pkHex);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
