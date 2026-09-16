import { encodeFunctionData, getAbiItem, getAddress, toFunctionSelector, type AbiFunction, type Hex } from "viem";

import type { ifs } from "@whm/common/evm";
import type { WalletContext } from "../types";

import landingJson from "../../../contracts/out/BasejumpLanding.sol/BasejumpLanding.json";
import receiverJson from "../../../contracts/out/BasejumpReceiver.sol/BasejumpReceiver.json";

// ERC-1967 implementation slot: bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1).
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

type Artifact = ifs.ContractArtifact & { deployedBytecode: { object: string } };

export type DeployImplParams = WalletContext & {
  proxy: Hex;
};

export type DeployImplResult = {
  implAddress: string;
  currentImplAddress: string;
  proxyAddress: string;
  proxyOwner: string;
  landingImplAddress: string;
  landingTransferSelector: string;
  // upgradeToAndCall(implAddress, 0x), to = proxyAddress — what the proxy owner submits.
  upgradeCalldata: string;
};

// Implementation only: the proxy is owner-gated and the owner is governance, so the upgrade is
// handed off as calldata rather than sent here.
export async function deployImpl(params: DeployImplParams): Promise<DeployImplResult> {
  const { publicClient, walletClient, proxy } = params;
  const { abi, bytecode, deployedBytecode } = receiverJson as Artifact;
  const { abi: landingAbi } = landingJson as ifs.ContractArtifact;

  const implOf = async (address: Hex): Promise<Hex> => {
    const slot = await publicClient.getStorageAt({ address, slot: IMPL_SLOT });
    return getAddress(`0x${(slot ?? "0x").slice(-40)}`);
  };

  const currentImplAddress = await implOf(proxy);
  const proxyOwner = (await publicClient.readContract({ address: proxy, abi, functionName: "owner" })) as Hex;
  const landing = (await publicClient.readContract({ address: proxy, abi, functionName: "landing" })) as Hex;
  const landingImplAddress = await implOf(getAddress(`0x${landing.slice(-40)}`));

  // The pool is not redeployed: the artifact must call the `transfer` the live pool dispatches.
  // A stale contracts/out, or a parameter grown back onto IBasejumpLanding, fails here.
  const transfer = getAbiItem({ abi: landingAbi, name: "transfer" }) as AbiFunction;
  const landingTransferSelector = toFunctionSelector(transfer);
  const selectorHex = landingTransferSelector.slice(2);
  const landingCode = (await publicClient.getCode({ address: landingImplAddress })) ?? "0x";
  if (!landingCode.includes(selectorHex)) {
    throw new Error(`live landing ${landingImplAddress} does not dispatch ${landingTransferSelector}`);
  }
  if (!deployedBytecode.object.includes(selectorHex)) {
    throw new Error(`receiver artifact does not call ${landingTransferSelector} — stale contracts/out?`);
  }

  const implHash = await walletClient.deployContract({ abi, bytecode: bytecode.object, args: [] });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: implHash });
  if (!receipt.contractAddress) throw new Error("Implementation deployment failed — no contract address.");
  const implAddress = receipt.contractAddress;

  // UUPS sanity: the new implementation must claim the slot the proxy delegates through.
  const uuid = await publicClient.readContract({ address: implAddress, abi, functionName: "proxiableUUID" });
  if (uuid !== IMPL_SLOT) throw new Error(`proxiableUUID mismatch: ${uuid}`);

  const upgradeCalldata = encodeFunctionData({ abi, functionName: "upgradeToAndCall", args: [implAddress, "0x"] });

  return {
    implAddress,
    currentImplAddress,
    proxyAddress: proxy,
    proxyOwner,
    landingImplAddress,
    landingTransferSelector,
    upgradeCalldata,
  };
}
