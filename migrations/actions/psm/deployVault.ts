import { encodeFunctionData } from "viem";

import type { ifs } from "@whm/common/evm";
import type { WalletContext } from "../types";

import vaultJson from "../../../contracts/out-psm/HollarBaseVault.sol/HollarBaseVault.json";
import erc1967ProxyJson from "../../../contracts/out-psm/ERC1967Proxy.sol/ERC1967Proxy.json";

/** See deployFacilitator for why artifacts come from out-psm/. */
export type DeployVaultParams = WalletContext & {
  wormholeCore: `0x${string}`;
  usdc: `0x${string}`;
  aUsdc: `0x${string}`;
  addressesProvider: `0x${string}`;
  hydrationChainId: number;
  minUsdcPrice: bigint;
  admin: `0x${string}`;
  guardian: `0x${string}`;
  treasurer: `0x${string}`;
  proxy?: `0x${string}`;
};

export type DeployResult = {
  implAddress: string;
  proxyAddress: string;
  ownerAddress: string;
};

export async function deployVault(params: DeployVaultParams): Promise<DeployResult> {
  const { publicClient, walletClient, account, proxy } = params;
  const { abi, bytecode } = vaultJson as ifs.ContractArtifact;

  const implHash = await walletClient.deployContract({ abi, bytecode: bytecode.object, args: [] });
  const implReceipt = await publicClient.waitForTransactionReceipt({ hash: implHash });
  if (!implReceipt.contractAddress) {
    throw new Error("Vault implementation deployment failed — no contract address.");
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

  // Named struct, not positional args: eleven of them do not fit on the stack, and a
  // transposed address here is not something a later setter can fix.
  const initializeData = encodeFunctionData({
    abi,
    functionName: "initializeVault",
    args: [
      {
        wormhole: params.wormholeCore,
        usdc: params.usdc,
        aUsdc: params.aUsdc,
        addressesProvider: params.addressesProvider,
        hydrationChainId: params.hydrationChainId,
        minUsdcPrice: params.minUsdcPrice,
        admin: params.admin,
        guardian: params.guardian,
        treasurer: params.treasurer,
      },
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
    throw new Error("Vault proxy deployment failed — no contract address.");
  }

  return {
    implAddress,
    proxyAddress: proxyReceipt.contractAddress,
    ownerAddress: account.address,
  };
}
