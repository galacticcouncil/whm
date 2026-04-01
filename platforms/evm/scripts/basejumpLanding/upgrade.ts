import "dotenv/config";

import fs from "node:fs";
import path from "node:path";
import { isAddress } from "viem";

import { args } from "@whm/common";
import { ifs, wallet } from "../../lib";

import basejumpLandingJson from "../../contracts/out/BasejumpLanding.sol/BasejumpLanding.json";

const { requiredArg, requiredEnv } = args;
const { getWallet } = wallet;

function getConfig() {
  const rpcUrl = requiredEnv("RPC");
  const chainId = requiredEnv("CHAIN_ID");

  const privateKey = process.env.PK_LANDING || process.env.PK || requiredArg("--pk");
  const proxy = requiredArg("--proxy");
  const env = requiredArg("--env");

  if (!isAddress(proxy)) throw new Error("Invalid proxy address.");

  return {
    rpcUrl,
    chainId: Number(chainId),
    privateKey: privateKey as `0x${string}`,
    proxy: proxy as `0x${string}`,
    env,
  };
}

async function main() {
  const config = getConfig();
  const { publicClient, walletClient, account } = getWallet(
    config.rpcUrl,
    config.chainId,
    config.privateKey,
  );
  const { abi, bytecode } = basejumpLandingJson as ifs.ContractArtifact;

  console.log("Deploying new BasejumpLanding implementation...");
  const implHash = await walletClient.deployContract({
    abi,
    bytecode: bytecode.object,
    args: [],
    gas: 5_000_000n,
  });

  const implReceipt = await publicClient.waitForTransactionReceipt({ hash: implHash });
  if (!implReceipt.contractAddress) throw new Error("Implementation deployment failed.");
  console.log("Implementation:", implReceipt.contractAddress);

  console.log("Upgrading proxy", config.proxy, "...");
  const upgradeHash = await walletClient.writeContract({
    address: config.proxy,
    abi,
    functionName: "upgradeToAndCall",
    args: [implReceipt.contractAddress, "0x"],
    gas: 1_000_000n,
  });

  const upgradeReceipt = await publicClient.waitForTransactionReceipt({ hash: upgradeHash });
  console.log("Upgraded. Tx:", upgradeReceipt.transactionHash);

  // Update deployment state
  const stateFile = path.resolve("deployments", config.env, "basejump-landing.json");
  if (fs.existsSync(stateFile)) {
    const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
    const deployStep = state.steps.find((s: any) => s.name === "deploy");
    if (deployStep?.output) {
      const prevImpl = deployStep.output.implAddress;
      deployStep.output.implAddress = implReceipt.contractAddress;
      console.log(`Updated ${stateFile}`);
      console.log(`  implAddress: ${prevImpl} -> ${implReceipt.contractAddress}`);
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n");
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
