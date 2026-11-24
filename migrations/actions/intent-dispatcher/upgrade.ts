import { encodeEventTopics, getAddress, type Hex } from "viem";

import type { ifs } from "@whm/common/evm";
import type { WalletContext } from "../types";

import intentDispatcherJson from "../../../contracts/out/IntentDispatcher.sol/IntentDispatcher.json";

/** ERC-1967 implementation slot: bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1). */
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

/** As for the first deploy: Hydration meters stored bytes, so the estimate cannot be trusted. */
const IMPL_DEPLOY_GAS = 12_000_000n;

type Artifact = ifs.ContractArtifact & { deployedBytecode: { object: string } };

/**
 * The implementation a proxy delegates to.
 *
 * @param params Hydration wallet
 * @param proxy The proxy
 * @returns Its implementation's address
 */
async function implOf(params: WalletContext, proxy: Hex): Promise<Hex> {
  const slot = await params.publicClient.getStorageAt({ address: proxy, slot: IMPL_SLOT });
  return getAddress(`0x${(slot ?? "0x").slice(-40)}`);
}

export type DeployImplResult = {
  implAddress: string;
  /** What the proxy runs now, before the upgrade. */
  currentImplAddress: string;
  proxyAddress: string;
};

/**
 * Deploys a new IntentDispatcher implementation for the live proxy. The artifact must emit
 * `OrderSourced` — a stale `contracts/out` would put the old code back.
 *
 * @param params Hydration wallet (an `EVMAccounts.ContractDeployer`), the dispatcher proxy
 * @returns The new implementation, and the one it replaces
 */
export async function deployImpl(params: WalletContext & { proxy: Hex }): Promise<DeployImplResult> {
  const { publicClient, walletClient, proxy } = params;
  const { abi, bytecode, deployedBytecode } = intentDispatcherJson as Artifact;

  const [sourced] = encodeEventTopics({ abi, eventName: "OrderSourced" });
  if (!deployedBytecode.object.includes(sourced!.slice(2))) {
    throw new Error("IntentDispatcher artifact does not emit OrderSourced — run forge build");
  }

  const currentImplAddress = await implOf(params, proxy);
  const hash = await walletClient.deployContract({ abi, bytecode: bytecode.object, args: [], gas: IMPL_DEPLOY_GAS });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) {
    throw new Error(`IntentDispatcher implementation deployment failed in ${hash}`);
  }

  // UUPS: the new implementation must claim the slot the proxy delegates through.
  const uuid = await publicClient.readContract({ address: receipt.contractAddress, abi, functionName: "proxiableUUID" });
  if (uuid !== IMPL_SLOT) throw new Error(`proxiableUUID mismatch: ${uuid}`);

  return { implAddress: receipt.contractAddress, currentImplAddress, proxyAddress: proxy };
}

export type UpgradeResult = {
  txHash: string;
  proxyAddress: string;
  implAddress: string;
};

/**
 * Points the dispatcher proxy at `impl`. The proxy is owner-gated and the deployer still owns it, so
 * this sends `upgradeToAndCall(impl, 0x)` itself — nothing initializes, the proxy's storage is
 * already live and the new code reads it unchanged.
 *
 * @param params Hydration wallet (the proxy's owner), the proxy, the new implementation
 * @returns The upgrade transaction, checked against the slot it set
 */
export async function upgrade(params: WalletContext & { proxy: Hex; impl: Hex }): Promise<UpgradeResult> {
  const { publicClient, walletClient, account, proxy, impl } = params;
  const { abi } = intentDispatcherJson as Artifact;

  const owner = (await publicClient.readContract({ address: proxy, abi, functionName: "owner" })) as Hex;
  if (getAddress(owner) !== getAddress(account.address)) {
    throw new Error(`dispatcher is owned by ${owner}, not the deployer ${account.address}`);
  }

  const txHash = await walletClient.writeContract({
    address: proxy,
    abi,
    functionName: "upgradeToAndCall",
    args: [impl, "0x"],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new Error(`upgrade reverted in ${txHash}`);
  if (getAddress(await implOf(params, proxy)) !== getAddress(impl)) {
    throw new Error(`proxy does not point at ${impl} after ${txHash}`);
  }

  return { txHash, proxyAddress: proxy, implAddress: impl };
}
