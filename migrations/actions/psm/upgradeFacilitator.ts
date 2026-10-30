import { encodeFunctionData, getAbiItem, getAddress, toFunctionSelector, type AbiFunction, type Hex } from "viem";

import type { ifs } from "@whm/common/evm";
import type { WalletContext } from "../types";

import facilitatorJson from "../../../contracts/out/HollarBaseFacilitator.sol/HollarBaseFacilitator.json";

// ERC-1967 implementation slot: bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1).
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

type Artifact = ifs.ContractArtifact & { deployedBytecode: { object: string } };

type ProxyParams = WalletContext & { proxy: Hex };

async function implOf({ publicClient }: WalletContext, proxy: Hex): Promise<Hex> {
  const slot = await publicClient.getStorageAt({ address: proxy, slot: IMPL_SLOT });
  return getAddress(`0x${(slot ?? "0x").slice(-40)}`);
}

function upgradeCalldata(implAddress: Hex): Hex {
  const { abi } = facilitatorJson as Artifact;
  return encodeFunctionData({ abi, functionName: "upgradeToAndCall", args: [implAddress, "0x"] });
}

export type DeployFacilitatorImplResult = {
  implAddress: string;
  currentImplAddress: string;
  proxyAddress: string;
  // upgradeToAndCall(implAddress, 0x), to = proxyAddress — what DEFAULT_ADMIN_ROLE submits.
  upgradeCalldata: string;
};

/**
 * Deploy a new facilitator implementation. Implementation only: the proxy's DEFAULT_ADMIN_ROLE is
 * the technical committee's emergency admin since 007, so the upgrade is handed off as calldata
 * rather than sent here.
 */
export async function deployFacilitatorImpl(params: ProxyParams): Promise<DeployFacilitatorImplResult> {
  const { publicClient, walletClient, proxy } = params;
  const { abi, bytecode, deployedBytecode } = facilitatorJson as Artifact;

  // A stale contracts/out would deploy the old code under a new address.
  const selector = toFunctionSelector(getAbiItem({ abi, name: "redeemWithPermit" }) as AbiFunction);
  if (!deployedBytecode.object.includes(selector.slice(2))) {
    throw new Error(`facilitator artifact does not dispatch redeemWithPermit ${selector} — stale contracts/out?`);
  }

  const currentImplAddress = await implOf(params, proxy);

  const implHash = await walletClient.deployContract({ abi, bytecode: bytecode.object, args: [] });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: implHash });
  if (!receipt.contractAddress) throw new Error("Implementation deployment failed — no contract address.");
  const implAddress = receipt.contractAddress;

  // UUPS sanity: the new implementation must claim the slot the proxy delegates through.
  const uuid = await publicClient.readContract({ address: implAddress, abi, functionName: "proxiableUUID" });
  if (uuid !== IMPL_SLOT) throw new Error(`proxiableUUID mismatch: ${uuid}`);

  return {
    implAddress,
    currentImplAddress,
    proxyAddress: proxy,
    upgradeCalldata: upgradeCalldata(implAddress),
  };
}

export type VerifyFacilitatorUpgradeResult = {
  proxyAddress: string;
  implAddress: string;
  verifiedAtBlock: string;
};

/**
 * Completes once the proxy delegates to `implAddress`, and sends nothing. Until the admin's
 * upgrade lands it fails with the calldata to submit; the runner re-runs a failed step on every
 * invocation, so the run after the motion enacts records it.
 */
export async function verifyFacilitatorUpgrade(
  params: ProxyParams & { implAddress: Hex },
): Promise<VerifyFacilitatorUpgradeResult> {
  const { publicClient, proxy } = params;
  const implAddress = getAddress(params.implAddress);

  const current = await implOf(params, proxy);
  if (current !== implAddress) {
    throw new Error(
      `${proxy} still delegates to ${current}, not ${implAddress}. The upgrade is DEFAULT_ADMIN_ROLE's ` +
        `(the TC emergency admin): call ${proxy} with ${upgradeCalldata(implAddress)} ` +
        `(upgradeToAndCall(${implAddress}, 0x)) through dispatch_as_emergency_admin, then re-run.`,
    );
  }

  return {
    proxyAddress: proxy,
    implAddress,
    verifiedAtBlock: (await publicClient.getBlockNumber()).toString(),
  };
}
