import "dotenv/config";

import { encodeFunctionData, isAddress } from "viem";

import { args } from "@whm/common";
import { ifs, wallet } from "../../lib";

import messageEmitterJson from "../../contracts/out/MessageEmitter.sol/MessageEmitter.json";
import erc1967ProxyJson from "../../contracts/out/ERC1967Proxy.sol/ERC1967Proxy.json";

const { requiredArg, optionalArg, requiredEnv } = args;
const { getWallet } = wallet;

function getConfig() {
  const rpcUrl = requiredEnv("EMITTER_RPC");
  const wormholeCore = requiredEnv("EMITTER_WORMHOLE_CORE");
  const chainId = requiredEnv("EMITTER_CHAIN_ID");

  if (!isAddress(wormholeCore)) throw new Error("Invalid wormhole core address.");

  const privateKey = requiredArg("--pk");

  const proxy = optionalArg("--proxy");
  if (proxy && !isAddress(proxy)) {
    throw new Error("Invalid --proxy address.");
  }

  return {
    rpcUrl,
    chainId: Number(chainId),
    privateKey: privateKey as `0x${string}`,
    wormholeCore: wormholeCore as `0x${string}`,
    proxy: proxy as `0x${string}` | undefined,
  };
}

async function main(): Promise<void> {
  const { rpcUrl, chainId, privateKey, wormholeCore, proxy } = getConfig();

  const { publicClient, walletClient, account } = getWallet(rpcUrl, chainId, privateKey);

  const { abi, bytecode } = messageEmitterJson as ifs.ContractArtifact;

  const implDeployHash = await walletClient.deployContract({
    abi,
    bytecode: bytecode.object,
    args: [],
  });

  const implDeployReceipt = await publicClient.waitForTransactionReceipt({ hash: implDeployHash });
  if (!implDeployReceipt.contractAddress) {
    throw new Error("Implementation deployment failed! Contract address missing.");
  }
  const implementationAddress = implDeployReceipt.contractAddress;

  if (proxy) {
    const upgradeHash = await walletClient.writeContract({
      address: proxy,
      abi,
      functionName: "upgradeToAndCall",
      args: [implementationAddress, "0x"],
    });

    await publicClient.waitForTransactionReceipt({ hash: upgradeHash });

    console.log("MessageEmitter implementation:", implementationAddress);
    console.log("MessageEmitter proxy:", proxy, "(upgraded)");
  } else {
    const initializeData = encodeFunctionData({
      abi,
      functionName: "initialize",
      args: [wormholeCore],
    });

    const { abi: proxyAbi, bytecode: proxyBytecode } = erc1967ProxyJson as ifs.ContractArtifact;

    const proxyDeployHash = await walletClient.deployContract({
      abi: proxyAbi,
      bytecode: proxyBytecode.object,
      args: [implementationAddress, initializeData],
    });

    const proxyDeployReceipt = await publicClient.waitForTransactionReceipt({
      hash: proxyDeployHash,
    });

    if (!proxyDeployReceipt.contractAddress) {
      throw new Error("Proxy deployment failed! Contract address missing.");
    }

    const emitterAddress = proxyDeployReceipt.contractAddress;

    console.log("MessageEmitter implementation:", implementationAddress);
    console.log("MessageEmitter proxy:", emitterAddress);
    console.log("MessageEmitter owner:", account.address);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
