import { encodeFunctionData } from "viem";
import { acc } from "@galacticcouncil/common";

import type { ifs } from "../../../lib";
import type { WalletContext } from "../../types";

import xcmTransactorJson from "../../../contracts/out/XcmTransactor.sol/XcmTransactor.json";
import erc1967ProxyJson from "../../../contracts/out/ERC1967Proxy.sol/ERC1967Proxy.json";

export type DeployTransactorParams = WalletContext & {
  destinationParaId: number;
  sourceParaId: number;
  evmPalletIndex: number;
  evmCallIndex: number;
  feeAsset: `0x${string}`;
  proxy?: `0x${string}`;
};

export type DeployTransactorResult = {
  implAddress: string;
  proxyAddress: string;
  ownerAddress: string;
  mda: string;
  mdaH160: string;
};

export async function deployTransactor(
  params: DeployTransactorParams,
): Promise<DeployTransactorResult> {
  const {
    publicClient,
    walletClient,
    account,
    destinationParaId,
    sourceParaId,
    evmPalletIndex,
    evmCallIndex,
    feeAsset,
    proxy,
  } = params;

  const { abi, bytecode } = xcmTransactorJson as ifs.ContractArtifact;

  // Deploy implementation
  const implHash = await walletClient.deployContract({
    abi,
    bytecode: bytecode.object,
    args: [destinationParaId, sourceParaId, evmPalletIndex, evmCallIndex, feeAsset],
  });
  const implReceipt = await publicClient.waitForTransactionReceipt({ hash: implHash });
  if (!implReceipt.contractAddress) {
    throw new Error("Implementation deployment failed — no contract address.");
  }
  const implAddress = implReceipt.contractAddress;

  // Upgrade existing proxy
  if (proxy) {
    const upgradeHash = await walletClient.writeContract({
      address: proxy,
      abi,
      functionName: "upgradeToAndCall",
      args: [implAddress, "0x"],
    });
    await publicClient.waitForTransactionReceipt({ hash: upgradeHash });

    const mda = acc.getMultilocationDerivatedAccount(sourceParaId, proxy, 1, false);
    const mdaH160 = acc.getMultilocationDerivatedAccount(sourceParaId, proxy, 1, true);

    return {
      implAddress,
      proxyAddress: proxy,
      ownerAddress: account.address,
      mda,
      mdaH160,
    };
  }

  // Deploy new proxy
  const initializeData = encodeFunctionData({ abi, functionName: "initialize", args: [] });
  const { abi: proxyAbi, bytecode: proxyBytecode } = erc1967ProxyJson as ifs.ContractArtifact;

  const proxyHash = await walletClient.deployContract({
    abi: proxyAbi,
    bytecode: proxyBytecode.object,
    args: [implAddress, initializeData],
  });
  const proxyReceipt = await publicClient.waitForTransactionReceipt({ hash: proxyHash });
  if (!proxyReceipt.contractAddress) {
    throw new Error("Proxy deployment failed — no contract address.");
  }
  const proxyAddress = proxyReceipt.contractAddress;

  // Auto-authorize owner
  const authHash = await walletClient.writeContract({
    address: proxyAddress,
    abi,
    functionName: "setAuthorized",
    args: [account.address, true],
  });
  await publicClient.waitForTransactionReceipt({ hash: authHash });

  // Compute multilocation-derived accounts
  const mda = acc.getMultilocationDerivatedAccount(sourceParaId, proxyAddress, 1, false);
  const mdaH160 = acc.getMultilocationDerivatedAccount(sourceParaId, proxyAddress, 1, true);

  return { implAddress, proxyAddress, ownerAddress: account.address, mda, mdaH160 };
}
