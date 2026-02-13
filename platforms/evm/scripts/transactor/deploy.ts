import "dotenv/config";

import { createPublicClient, createWalletClient, encodeFunctionData, http, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { args } from "@nohaapav/whm-sdk";
import { chains, ifs } from "../../lib";

import xcmTransactorJson from "../../contracts/out/XcmTransactor.sol/XcmTransactor.json";
import erc1967ProxyJson from "../../contracts/out/ERC1967Proxy.sol/ERC1967Proxy.json";

const { requiredArg, optionalArg, requiredEnv } = args;
const { getChain } = chains;

function parseUint(value: string, bitSize: 8 | 32, argName: string): number {
  const parsed = Number(value);
  const max = bitSize === 8 ? 2 ** 8 - 1 : 2 ** 32 - 1;

  if (!Number.isInteger(parsed) || parsed < 0 || parsed > max) {
    throw new Error(`Invalid ${argName} (expected uint${bitSize} value: 0-${max}).`);
  }

  return parsed;
}

function getConfig() {
  const rpcUrl = requiredEnv("RECEIVER_RPC");
  const chainId = requiredEnv("RECEIVER_CHAIN_ID");

  const privateKey = requiredArg("--pk");
  const hydrationParaId = parseUint(
    requiredArg("--destination-para-id"),
    32,
    "--destination-para-id",
  );
  const sourceParaId = parseUint(requiredArg("--source-para-id"), 32, "--source-para-id");
  const evmPalletIndex = parseUint(requiredArg("--evm-pallet-index"), 8, "--evm-pallet-index");
  const evmCallIndex = parseUint(requiredArg("--evm-call-index"), 8, "--evm-call-index");
  const feeAsset = requiredArg("--fee-asset");
  if (!isAddress(feeAsset)) {
    throw new Error("Invalid --fee-asset.");
  }

  const proxy = optionalArg("--proxy");
  if (proxy && !isAddress(proxy)) {
    throw new Error("Invalid --proxy address.");
  }

  return {
    rpcUrl,
    chainId: Number(chainId),
    privateKey: privateKey as `0x${string}`,
    hydrationParaId,
    sourceParaId,
    evmPalletIndex,
    evmCallIndex,
    feeAsset: feeAsset as `0x${string}`,
    proxy: proxy as `0x${string}` | undefined,
  };
}

async function main(): Promise<void> {
  const {
    rpcUrl,
    chainId,
    privateKey,
    hydrationParaId,
    sourceParaId,
    evmPalletIndex,
    evmCallIndex,
    feeAsset,
    proxy,
  } = getConfig();

  const account = privateKeyToAccount(privateKey);
  const chain = getChain(chainId);

  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({
    account: account,
    chain,
    transport,
  });

  const { abi, bytecode } = xcmTransactorJson as ifs.ContractArtifact;

  const implDeployHash = await walletClient.deployContract({
    abi,
    bytecode: bytecode.object,
    args: [hydrationParaId, sourceParaId, evmPalletIndex, evmCallIndex, feeAsset],
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

    console.log("XcmTransactor implementation:", implementationAddress);
    console.log("XcmTransactor proxy:", proxy, "(upgraded)");
  } else {
    const initializeData = encodeFunctionData({
      abi,
      functionName: "initialize",
      args: [],
    });

    const { abi: proxyAbi, bytecode: proxyBytecode } = erc1967ProxyJson as ifs.ContractArtifact;

    const proxyDeployHash = await walletClient.deployContract({
      abi: proxyAbi,
      bytecode: proxyBytecode.object,
      args: [implementationAddress, initializeData],
    });

    const proxyDeployReceipt = await publicClient.waitForTransactionReceipt({ hash: proxyDeployHash });
    if (!proxyDeployReceipt.contractAddress) {
      throw new Error("Proxy deployment failed! Contract address missing.");
    }

    const transactorAddress = proxyDeployReceipt.contractAddress;

    const setAuthorizedHash = await walletClient.writeContract({
      address: transactorAddress,
      abi,
      functionName: "setAuthorized",
      args: [account.address, true],
    });

    await publicClient.waitForTransactionReceipt({ hash: setAuthorizedHash });

    console.log("XcmTransactor implementation:", implementationAddress);
    console.log("XcmTransactor proxy:", transactorAddress);
    console.log("XcmTransactor owner:", account.address);
    console.log("XcmTransactor authorized:", account.address);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
