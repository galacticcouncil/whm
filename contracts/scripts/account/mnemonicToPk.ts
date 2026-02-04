import { mnemonicToAccount } from "viem/accounts";

import { loadEnv } from "../env";

async function main(): Promise<void> {
  loadEnv();

  const seed = process.env.ACCOUNT_SEED;
  if (!seed) {
    throw Error("No account seed provided!");
  }

  const account = mnemonicToAccount(seed);
  if (account) {
    const hdKey = account.getHdKey();
    const privateKey = hdKey.privateKey!;
    const pk = `0x${Buffer.from(privateKey).toString("hex")}`;
    console.log("Private key:", pk);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
