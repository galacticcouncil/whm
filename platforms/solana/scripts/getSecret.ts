import * as anchor from "@coral-xyz/anchor";

import { args } from "@whm/common";

import { mnemonicToSeedSync } from "bip39";
import { derivePath } from "ed25519-hd-key";

const { Keypair } = anchor.web3;
const { requiredArg, optionalArg } = args;

function deriveKeypair(mnemonic: string, account: number): anchor.web3.Keypair {
  const seed = mnemonicToSeedSync(mnemonic);
  const { key } = derivePath(`m/44'/501'/${account}'/0'`, seed.toString("hex"));
  return Keypair.fromSeed(key);
}

async function main() {
  const mnemonic = requiredArg("--seed");
  const address = optionalArg("--address");

  if (address) {
    for (let i = 0; i < 20; i++) {
      const keypair = deriveKeypair(mnemonic, i);
      if (keypair.publicKey.toBase58() === address) {
        console.log("Account index:", i);
        console.log("Public key:", keypair.publicKey.toBase58());
        console.log("Private key:", anchor.utils.bytes.bs58.encode(keypair.secretKey));
        return;
      }
    }
    throw new Error(`Address ${address} not found in first 20 accounts.`);
  }

  const keypair = deriveKeypair(mnemonic, 0);
  console.log("Public key:", keypair.publicKey.toBase58());
  console.log("Private key:", anchor.utils.bytes.bs58.encode(keypair.secretKey));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
