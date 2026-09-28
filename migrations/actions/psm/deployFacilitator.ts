import { encodeFunctionData } from "viem";

import type { ifs } from "@whm/common/evm";
import type { WalletContext } from "../types";

import facilitatorJson from "../../../contracts/out-psm/HollarBaseFacilitator.sol/HollarBaseFacilitator.json";
import erc1967ProxyJson from "../../../contracts/out-psm/ERC1967Proxy.sol/ERC1967Proxy.json";

/**
 * Artifacts come from out-psm/, not out/. The PSM contracts are built under the `psm` Foundry
 * profile (optimizer + via-IR) because HollarBaseVault does not fit under EIP-170 without it.
 * Build with `FOUNDRY_PROFILE=psm forge build` before running this migration.
 */
export type DeployFacilitatorParams = WalletContext & {
  wormholeCore: `0x${string}`;
  hollar: `0x${string}`;
  usdcDecimals: number;
  baseChainId: number;
  admin: `0x${string}`;
  guardian: `0x${string}`;
  proxy?: `0x${string}`;
};

export type DeployResult = {
  implAddress: string;
  proxyAddress: string;
  ownerAddress: string;
};

export async function deployFacilitator(params: DeployFacilitatorParams): Promise<DeployResult> {
  const { publicClient, walletClient, account, proxy } = params;
  const { abi, bytecode } = facilitatorJson as ifs.ContractArtifact;

  const implHash = await walletClient.deployContract({ abi, bytecode: bytecode.object, args: [] });
  const implReceipt = await publicClient.waitForTransactionReceipt({ hash: implHash });
  if (!implReceipt.contractAddress) {
    throw new Error("Facilitator implementation deployment failed — no contract address.");
  }
  const implAddress = implReceipt.contractAddress;

  if (proxy) {
    const upgradeHash = await walletClient.writeContract({
      address: proxy,
      abi,
      functionName: "upgradeToAndCall",
      args: [implAddress, "0x"],
    });
    await publicClient.waitForTransactionReceipt({ hash: upgradeHash });
    return { implAddress, proxyAddress: proxy, ownerAddress: account.address };
  }

  const initializeData = encodeFunctionData({
    abi,
    functionName: "initializeFacilitator",
    args: [
      params.wormholeCore,
      params.hollar,
      params.usdcDecimals,
      params.baseChainId,
      params.admin,
      params.guardian,
    ],
  });

  const { abi: proxyAbi, bytecode: proxyBytecode } = erc1967ProxyJson as ifs.ContractArtifact;
  const proxyHash = await walletClient.deployContract({
    abi: proxyAbi,
    bytecode: proxyBytecode.object,
    args: [implAddress, initializeData],
  });
  const proxyReceipt = await publicClient.waitForTransactionReceipt({ hash: proxyHash });
  if (!proxyReceipt.contractAddress) {
    throw new Error("Facilitator proxy deployment failed — no contract address.");
  }

  return {
    implAddress,
    proxyAddress: proxyReceipt.contractAddress,
    ownerAddress: account.address,
  };
}
