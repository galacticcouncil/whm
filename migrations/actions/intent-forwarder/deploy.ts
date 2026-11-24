import { encodeFunctionData } from "viem";

import type { ifs } from "@whm/common/evm";
import type { WalletContext } from "../types";

import intentForwarderJson from "../../../contracts/out/IntentForwarder.sol/IntentForwarder.json";
import erc1967ProxyJson from "../../../contracts/out/ERC1967Proxy.sol/ERC1967Proxy.json";

export type DeployParams = WalletContext & {
  /** Wormhole core bridge on Ethereum — parses the settlement VAA. */
  wormhole: `0x${string}`;
  /** The WETH NTT WormholeTransceiver on Ethereum — delivers the settlement. */
  transceiver: `0x${string}`;
};

export type DeployResult = {
  implAddress: string;
  proxyAddress: string;
  ownerAddress: string;
};

/**
 * Deploys the IntentForwarder implementation and its ERC-1967 proxy, initialised in the proxy's
 * constructor. The deployer owns it.
 *
 * @param params Ethereum wallet, Wormhole core, WETH NTT transceiver
 * @returns The implementation, the proxy the dispatcher addresses its transfers to, and its owner
 */
export async function deploy(params: DeployParams): Promise<DeployResult> {
  const { publicClient, walletClient, account, wormhole, transceiver } = params;
  const { abi, bytecode } = intentForwarderJson as ifs.ContractArtifact;

  const implHash = await walletClient.deployContract({ abi, bytecode: bytecode.object, args: [] });
  const implReceipt = await publicClient.waitForTransactionReceipt({ hash: implHash });
  if (implReceipt.status !== "success" || !implReceipt.contractAddress) {
    throw new Error(`IntentForwarder implementation deployment failed in ${implHash}`);
  }
  const implAddress = implReceipt.contractAddress;

  const { abi: proxyAbi, bytecode: proxyBytecode } = erc1967ProxyJson as ifs.ContractArtifact;
  const proxyHash = await walletClient.deployContract({
    abi: proxyAbi,
    bytecode: proxyBytecode.object,
    args: [implAddress, encodeFunctionData({ abi, functionName: "initialize", args: [wormhole, transceiver] })],
  });
  const proxyReceipt = await publicClient.waitForTransactionReceipt({ hash: proxyHash });
  if (proxyReceipt.status !== "success" || !proxyReceipt.contractAddress) {
    throw new Error(`IntentForwarder proxy deployment failed in ${proxyHash}`);
  }

  return { implAddress, proxyAddress: proxyReceipt.contractAddress, ownerAddress: account.address };
}
