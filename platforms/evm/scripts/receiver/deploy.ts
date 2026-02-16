import "dotenv/config";

import { encodeFunctionData, isAddress } from "viem";

import { args } from "@whm/common";
import { ifs, wallet } from "../../lib";

import messageReceiverJson from "../../contracts/out/MessageReceiver.sol/MessageReceiver.json";
import erc1967ProxyJson from "../../contracts/out/ERC1967Proxy.sol/ERC1967Proxy.json";

const { requiredArg, optionalArg, requiredEnv } = args;
const { getWallet } = wallet;

function getConfig() {
  const rpcUrl = requiredEnv("RECEIVER_RPC");
  const wormholeRelayer = requiredEnv("RECEIVER_WORMHOLE_RELAYER");
  const wormholeCore = requiredEnv("RECEIVER_WORMHOLE_CORE");
  const chainId = requiredEnv("RECEIVER_CHAIN_ID");

  if (!isAddress(wormholeRelayer)) throw new Error("Invalid wormhole relayer address.");
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
    wormholeRelayer: wormholeRelayer as `0x${string}`,
    wormholeCore: wormholeCore as `0x${string}`,
    proxy: proxy as `0x${string}` | undefined,
  };
}

async function main(): Promise<void> {
  const { rpcUrl, chainId, privateKey, wormholeCore, wormholeRelayer, proxy } = getConfig();

  const { publicClient, walletClient, account } = getWallet(rpcUrl, chainId, privateKey);

  const { abi, bytecode } = messageReceiverJson as ifs.ContractArtifact;

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

    console.log("MessageReceiver implementation:", implementationAddress);
    console.log("MessageReceiver proxy:", proxy, "(upgraded)");
  } else {
    const initializeData = encodeFunctionData({
      abi,
      functionName: "initialize",
      args: [wormholeRelayer, wormholeCore],
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

    const receiverAddress = proxyDeployReceipt.contractAddress;

    const setAuthorizedHash = await walletClient.writeContract({
      address: receiverAddress,
      abi,
      functionName: "setAuthorized",
      args: [account.address, true],
    });

    await publicClient.waitForTransactionReceipt({ hash: setAuthorizedHash });

    console.log("MessageReceiver implementation:", implementationAddress);
    console.log("MessageReceiver proxy:", receiverAddress);
    console.log("MessageReceiver owner:", account.address);
    console.log("MessageReceiver authorized:", account.address);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
