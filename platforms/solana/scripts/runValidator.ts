import * as anchor from "@coral-xyz/anchor";

const { PublicKey, Connection } = anchor.web3;

const RPC = "https://api.mainnet-beta.solana.com";
const WORMHOLE_PROGRAM_ID = new PublicKey("worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth");

// Wormhole PDAs
const [BRIDGE_CONFIG] = PublicKey.findProgramAddressSync(
  [Buffer.from("Bridge")],
  WORMHOLE_PROGRAM_ID,
);
const [FEE_COLLECTOR] = PublicKey.findProgramAddressSync(
  [Buffer.from("fee_collector")],
  WORMHOLE_PROGRAM_ID,
);

async function getGuardianSet(): Promise<InstanceType<typeof PublicKey>> {
  const conn = new Connection(RPC, "confirmed");
  const info = await conn.getAccountInfo(BRIDGE_CONFIG);
  if (!info) throw new Error("Bridge Config account not found on mainnet");

  const guardianIndex = info.data.readUInt32LE(0);
  console.log(`Active guardian set index: ${guardianIndex}`);

  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(guardianIndex);
  const [guardianSet] = PublicKey.findProgramAddressSync(
    [Buffer.from("GuardianSet"), buf],
    WORMHOLE_PROGRAM_ID,
  );
  return guardianSet;
}

async function main() {
  const guardianSet = await getGuardianSet();

  const accounts = {
    "Wormhole Program": WORMHOLE_PROGRAM_ID.toBase58(),
    "Bridge Config": BRIDGE_CONFIG.toBase58(),
    "Fee Collector": FEE_COLLECTOR.toBase58(),
    "Guardian Set": guardianSet.toBase58(),
  };

  console.log("\nCloning from mainnet:");
  for (const [name, addr] of Object.entries(accounts)) {
    console.log(`  ${name}: ${addr}`);
  }
  console.log();

  const args = [
    "solana-test-validator",
    "--ledger",
    ".anchor/test-ledger",
    "--rpc-port",
    "8898",
    "--url",
    RPC,
    "--reset",
    "--clone-upgradeable-program",
    WORMHOLE_PROGRAM_ID.toBase58(),
    "--clone",
    BRIDGE_CONFIG.toBase58(),
    "--clone",
    FEE_COLLECTOR.toBase58(),
    "--clone",
    guardianSet.toBase58(),
  ];

  console.log(`> ${args.join(" ")}\n`);

  const { execSync } = await import("child_process");
  execSync(args.join(" "), { stdio: "inherit" });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
