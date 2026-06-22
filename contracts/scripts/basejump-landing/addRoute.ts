import "dotenv/config";

import { encodeFunctionData, getAddress, isAddress } from "viem";

import { args } from "@whm/common";
import { ifs, wallet } from "@whm/common/evm";

import basejumpLandingJson from "../../out/BasejumpLanding.sol/BasejumpLanding.json";

// Add a Basejump route on the Hydration landing: authorize the corridor bridge (XcmTransactor MDA)
// and map sourceAsset -> destAsset. Both are onlyOwner (Hydration TC). Prints calldata by default;
// --send submits directly (requires the owner key via PK_LANDING / PK / --pk).

const { optionalArg, requiredEnv } = args;
const { getWallet } = wallet;

const DUMMY_PK = "0x0000000000000000000000000000000000000000000000000000000000000001";

function addr(name: string, value: string | null | undefined): `0x${string}` {
  if (!value) throw new Error(`Missing ${name} (pass --${name} or set its env var)`);
  if (!isAddress(value)) throw new Error(`Invalid address for ${name}: ${value}`);
  return getAddress(value);
}

function getConfig() {
  return {
    rpcUrl: requiredEnv("RPC"),
    chainId: Number(requiredEnv("CHAIN_ID")),
    landing: addr("landing", optionalArg("--landing") || process.env.HYDRATION_LANDING),
    bridge: addr("bridge", optionalArg("--bridge") || process.env.BRIDGE_MDA),
    sourceAsset: addr("source", optionalArg("--source") || process.env.USDC_SOURCE_ASSET),
    destAsset: addr("dest", optionalArg("--dest") || process.env.USDC_DEST_ASSET),
    send: process.argv.includes("--send"),
    privateKey: process.env.PK_LANDING || process.env.PK || optionalArg("--pk"),
  };
}

async function main() {
  const cfg = getConfig();
  const { abi } = basejumpLandingJson as ifs.ContractArtifact;
  const { publicClient, walletClient } = getWallet(
    cfg.rpcUrl,
    cfg.chainId,
    (cfg.privateKey || DUMMY_PK) as `0x${string}`,
  );

  const bridgeAuthorized = (await publicClient.readContract({
    address: cfg.landing,
    abi,
    functionName: "authorizedBridges",
    args: [cfg.bridge],
  })) as boolean;
  const currentDest = (await publicClient.readContract({
    address: cfg.landing,
    abi,
    functionName: "destAssetFor",
    args: [cfg.sourceAsset],
  })) as string;

  console.log(`Landing:      ${cfg.landing}`);
  console.log(`Bridge (MDA): ${cfg.bridge}  authorized=${bridgeAuthorized}`);
  console.log(`Source asset: ${cfg.sourceAsset}`);
  console.log(`Dest asset:   ${cfg.destAsset}  current=${currentDest}`);
  console.log();

  const calls: { label: string; functionName: string; args: unknown[] }[] = [];
  if (!bridgeAuthorized) {
    calls.push({ label: "setAuthorizedBridge", functionName: "setAuthorizedBridge", args: [cfg.bridge, true] });
  } else {
    console.log("bridge already authorized — skipping setAuthorizedBridge");
  }
  if (getAddress(currentDest) !== cfg.destAsset) {
    calls.push({ label: "setDestAsset", functionName: "setDestAsset", args: [cfg.sourceAsset, cfg.destAsset] });
  } else {
    console.log("dest asset already mapped — skipping setDestAsset");
  }

  if (calls.length === 0) {
    console.log("\nRoute already configured. Nothing to do.");
    return;
  }

  console.log("\n=== owner calls (to = landing) ===");
  for (const c of calls) {
    const data = encodeFunctionData({ abi, functionName: c.functionName, args: c.args });
    console.log(`\n${c.label}`);
    console.log(`  to:   ${cfg.landing}`);
    console.log(`  data: ${data}`);
  }

  if (!cfg.send) {
    console.log("\n(dry run) onlyOwner calls — owner is the Hydration TC.");
    console.log("Submit the above via governance, or re-run with --send if you hold the owner key.");
    return;
  }

  if (!cfg.privateKey) {
    throw new Error("--send requires the owner key (PK_LANDING / PK / --pk)");
  }
  for (const c of calls) {
    console.log(`\nsending ${c.label} ...`);
    const hash = await walletClient.writeContract({
      address: cfg.landing,
      abi,
      functionName: c.functionName,
      args: c.args,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`  tx: ${receipt.transactionHash} (status: ${receipt.status})`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
