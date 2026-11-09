import { encodeFunctionData } from "viem";

import type { ifs } from "@whm/common/evm";
import type { WalletContext } from "../types";

import emitterJson from "../../../contracts/out/BasejumpEmitter.sol/BasejumpEmitter.json";
import erc1967ProxyJson from "../../../contracts/out/ERC1967Proxy.sol/ERC1967Proxy.json";

/** Wormhole consistency levels the emitter's constructor accepts: instant (200) or safe (201). */
export type FastPathConsistency = 200 | 201;

export type DeployParams = WalletContext & {
  wormholeId: number;
  wormholeCore: `0x${string}`;
  /**
   * Constructor argument of the IMPLEMENTATION: the level every fast-path message is published
   * at. Required on the upgrade path too, because an upgrade installs a new implementation and so
   * chooses the level again. basejump-ethereum passes 200, basejump-base passes 201.
   */
  consistencyLevel: FastPathConsistency;
  proxy?: `0x${string}`;
};

/** Parse an env value into a level the constructor accepts; anything else throws. */
export function parseFastPathConsistency(name: string, value: string | undefined): FastPathConsistency {
  if (value === "200") return 200;
  if (value === "201") return 201;
  throw new Error(`${name} must be 200 (instant) or 201 (safe), got ${JSON.stringify(value)}`);
}

export type DeployResult = {
  implAddress: string;
  proxyAddress: string;
  ownerAddress: string;
  wormholeId: string;
  consistencyLevel: string;
};

export async function deploy(params: DeployParams): Promise<DeployResult> {
  const { publicClient, walletClient, account, wormholeCore, wormholeId, consistencyLevel, proxy } = params;
  const { abi, bytecode } = emitterJson as ifs.ContractArtifact;

  if (consistencyLevel !== 200 && consistencyLevel !== 201) {
    throw new Error(`consistencyLevel must be 200 or 201, got ${consistencyLevel}`);
  }

  const implHash = await walletClient.deployContract({
    abi,
    bytecode: bytecode.object,
    args: [consistencyLevel],
  });

  const implReceipt = await publicClient.waitForTransactionReceipt({ hash: implHash });
  if (!implReceipt.contractAddress) {
    throw new Error("Implementation deployment failed — no contract address.");
  }

  const implAddress = implReceipt.contractAddress;

  // Read the level back from the deployed implementation before any proxy points at it.
  const builtLevel = Number(
    await publicClient.readContract({ address: implAddress, abi, functionName: "CONSISTENCY_LEVEL" }),
  );
  if (builtLevel !== consistencyLevel) {
    throw new Error(`implementation ${implAddress} reports CONSISTENCY_LEVEL ${builtLevel}, expected ${consistencyLevel}`);
  }

  if (proxy) {
    const upgradeHash = await walletClient.writeContract({
      address: proxy,
      abi,
      functionName: "upgradeToAndCall",
      args: [implAddress, "0x"],
    });
    await publicClient.waitForTransactionReceipt({ hash: upgradeHash });

    return {
      implAddress,
      proxyAddress: proxy,
      ownerAddress: account.address,
      wormholeId: String(wormholeId),
      consistencyLevel: String(consistencyLevel),
    };
  }

  const initializeData = encodeFunctionData({
    abi,
    functionName: "initialize",
    args: [wormholeCore],
  });

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

  return {
    implAddress,
    proxyAddress: proxyReceipt.contractAddress,
    ownerAddress: account.address,
    wormholeId: String(wormholeId),
    consistencyLevel: String(consistencyLevel),
  };
}
