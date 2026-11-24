import { encodeFunctionData } from "viem";

import type { ifs } from "@whm/common/evm";
import type { WalletContext } from "../types";

import intentDispatcherJson from "../../../contracts/out/IntentDispatcher.sol/IntentDispatcher.json";
import erc1967ProxyJson from "../../../contracts/out/ERC1967Proxy.sol/ERC1967Proxy.json";

/**
 * Hydration charges ~366 gas per stored byte, so the ~22 KB implementation alone needs ~8M; the
 * estimate cannot be trusted under its storage metering. Held up front as gas × fee, refunded after.
 */
const IMPL_DEPLOY_GAS = 12_000_000n;

export type DeployParams = WalletContext & {
  /** Wormhole core bridge on Hydration — the order message's publisher. */
  wormhole: `0x${string}`;
};

export type DeployResult = {
  implAddress: string;
  proxyAddress: string;
  ownerAddress: string;
};

/**
 * Deploys the IntentDispatcher implementation and its ERC-1967 proxy, initialised in the proxy's
 * constructor — no window in which anyone else can call `initialize`. The deployer owns it.
 *
 * @param params Hydration wallet (an `EVMAccounts.ContractDeployer`), Wormhole core
 * @returns The implementation, the proxy every other contract pins, and its owner
 */
export async function deploy(params: DeployParams): Promise<DeployResult> {
  const { publicClient, walletClient, account, wormhole } = params;
  const { abi, bytecode } = intentDispatcherJson as ifs.ContractArtifact;

  const implHash = await walletClient.deployContract({
    abi,
    bytecode: bytecode.object,
    args: [],
    gas: IMPL_DEPLOY_GAS,
  });
  const implReceipt = await publicClient.waitForTransactionReceipt({ hash: implHash });
  if (implReceipt.status !== "success" || !implReceipt.contractAddress) {
    throw new Error(`IntentDispatcher implementation deployment failed in ${implHash}`);
  }
  const implAddress = implReceipt.contractAddress;

  const { abi: proxyAbi, bytecode: proxyBytecode } = erc1967ProxyJson as ifs.ContractArtifact;
  const proxyHash = await walletClient.deployContract({
    abi: proxyAbi,
    bytecode: proxyBytecode.object,
    args: [implAddress, encodeFunctionData({ abi, functionName: "initialize", args: [wormhole] })],
  });
  const proxyReceipt = await publicClient.waitForTransactionReceipt({ hash: proxyHash });
  if (proxyReceipt.status !== "success" || !proxyReceipt.contractAddress) {
    throw new Error(`IntentDispatcher proxy deployment failed in ${proxyHash}`);
  }

  return { implAddress, proxyAddress: proxyReceipt.contractAddress, ownerAddress: account.address };
}
