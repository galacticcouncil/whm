import "dotenv/config";

import { encodeFunctionData, isAddress } from "viem";

import { args } from "@whm/common";
import { acc } from "@galacticcouncil/common";

import { ifs, wallet } from "../../lib";

import xcmTransactorJson from "../../contracts/out/XcmTransactor.sol/XcmTransactor.json";
import erc1967ProxyJson from "../../contracts/out/ERC1967Proxy.sol/ERC1967Proxy.json";

const { requiredArg, optionalArg, requiredEnv } = args;
const { getWallet } = wallet;

function getConfig() {
  const rpcUrl = requiredEnv("RECEIVER_RPC");
  const chainId = requiredEnv("RECEIVER_CHAIN_ID");

  const privateKey = requiredArg("--pk");
  const destinationParaId = requiredArg("--destination-para-id");
  const sourceParaId = requiredArg("--source-para-id");
  const evmPalletIndex = requiredArg("--evm-pallet-index");
  const evmCallIndex = requiredArg("--evm-call-index");
  const feeAsset = requiredArg("--fee-asset");

  if (!isAddress(feeAsset)) throw new Error("Invalid --fee-asset.");

  const proxy = optionalArg("--proxy");
  if (proxy && !isAddress(proxy)) {
    throw new Error("Invalid --proxy address.");
  }

  return {
    rpcUrl,
    chainId: Number(chainId),
    privateKey: privateKey as `0x${string}`,
    destinationParaId: Number(destinationParaId),
    sourceParaId: Number(sourceParaId),
    evmPalletIndex: Number(evmPalletIndex),
    evmCallIndex: Number(evmCallIndex),
    feeAsset: feeAsset as `0x${string}`,
    proxy: proxy as `0x${string}` | undefined,
  };
}

async function main(): Promise<void> {
  const {
    rpcUrl,
    chainId,
    privateKey,
    destinationParaId,
    sourceParaId,
    evmPalletIndex,
    evmCallIndex,
    feeAsset,
    proxy,
  } = getConfig();

  const { publicClient, walletClient, account } = getWallet(rpcUrl, chainId, privateKey);

  const { abi, bytecode } = xcmTransactorJson as ifs.ContractArtifact;

  const implDeployHash = await walletClient.deployContract({
    abi,
    bytecode: bytecode.object,
    args: [destinationParaId, sourceParaId, evmPalletIndex, evmCallIndex, feeAsset],
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

    const proxyDeployReceipt = await publicClient.waitForTransactionReceipt({
      hash: proxyDeployHash,
    });
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

    const proxyMda = acc.getMultilocationDerivatedAccount(
      sourceParaId,
      transactorAddress,
      1,
      false,
    );

    const proxyMdaH160 = acc.getMultilocationDerivatedAccount(
      sourceParaId,
      transactorAddress,
      1,
      true,
    );

    console.log("XcmTransactor MDA:", proxyMda);
    console.log("XcmTransactor MDA (H160):", proxyMdaH160);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
