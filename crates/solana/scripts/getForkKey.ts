import fs from "fs";
import path from "path";

import * as anchor from "@coral-xyz/anchor";

const { Keypair } = anchor.web3;

const KEYPAIR_FILE = path.resolve(__dirname, "../.fork/keypair.json");

function loadOrCreate(): InstanceType<typeof Keypair> {
  fs.mkdirSync(path.dirname(KEYPAIR_FILE), { recursive: true });
  if (fs.existsSync(KEYPAIR_FILE)) {
    const bytes = JSON.parse(fs.readFileSync(KEYPAIR_FILE, "utf8"));
    return Keypair.fromSecretKey(Uint8Array.from(bytes));
  }
  const kp = Keypair.generate();
  fs.writeFileSync(KEYPAIR_FILE, JSON.stringify(Array.from(kp.secretKey)));
  process.stderr.write(`Generated fork keypair: ${kp.publicKey.toBase58()}\n`);
  return kp;
}

const kp = loadOrCreate();
process.stdout.write(anchor.utils.bytes.bs58.encode(kp.secretKey));
