import {
  encodeFunctionData,
  getAddress,
  keccak256,
  pad,
  type Address,
  type Hex,
} from "viem";

import type { ifs, wallet } from "@whm/common/evm";

import dispatcherJson from "../../../contracts/out/GovernanceDispatcher.sol/GovernanceDispatcher.json";
import executorJson from "../../../contracts/out/GovernanceExecutor.sol/GovernanceExecutor.json";
import proxyJson from "../../../contracts/out/ERC1967Proxy.sol/ERC1967Proxy.json";

const IMPLEMENTATION_SLOT: Hex =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

const wormholeAbi = [
  {
    type: "function",
    name: "chainId",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint16" }],
  },
  {
    type: "function",
    name: "messageFee",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const;

const safeAbi = [
  {
    type: "function",
    name: "getThreshold",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "getOwners",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address[]" }],
  },
] as const;

type GovernanceArtifact = ifs.ContractArtifact;
type WalletContext = ReturnType<typeof wallet.getWallet>;

export type DeployImplementationResult = {
  implAddress: string;
  deployTxHash: string;
  runtimeCodeHash: string;
  proxiableUUID: string;
};

export type DeployDispatcherProxyParams = WalletContext & {
  implAddress: Address;
  wormholeCore: Address;
  expectedWormholeId: number;
  governanceCaller: Address;
};

export type DeployDispatcherProxyResult = {
  proxyAddress: string;
  deployTxHash: string;
  runtimeCodeHash: string;
  implAddress: string;
  wormholeCore: string;
  wormholeId: string;
  governanceCaller: string;
  nextGovernanceNonce: string;
  governanceCallerBalance: string;
  governanceCallerNonce: string;
  wormholeMessageFee: string;
};

export type DeployExecutorProxyParams = WalletContext & {
  implAddress: Address;
  wormholeCore: Address;
  expectedWormholeId: number;
  sourceDispatcher: Address;
  vetoer: Address;
  expectedVetoerThreshold: number;
  expectedVetoerOwnerCount: number;
  vetoPeriod: number;
  executionGracePeriod: number;
};

export type DeployExecutorProxyResult = {
  proxyAddress: string;
  deployTxHash: string;
  runtimeCodeHash: string;
  implAddress: string;
  wormholeCore: string;
  wormholeId: string;
  sourceDispatcher: string;
  sourceDispatcherBytes32: string;
  vetoer: string;
  vetoerThreshold: string;
  vetoerOwners: string;
  vetoPeriod: string;
  executionGracePeriod: string;
};

async function requireCode(
  publicClient: WalletContext["publicClient"],
  address: Address,
  label: string,
): Promise<Hex> {
  const code = await publicClient.getCode({ address });
  if (!code || code === "0x") throw new Error(`${label} has no code: ${address}`);
  return code;
}

async function implementationOf(
  publicClient: WalletContext["publicClient"],
  proxy: Address,
): Promise<Address> {
  const value = await publicClient.getStorageAt({ address: proxy, slot: IMPLEMENTATION_SLOT });
  if (!value || value === "0x") throw new Error(`Missing ERC-1967 implementation slot on ${proxy}`);
  return getAddress(`0x${value.slice(-40)}`);
}

async function readWormholeId(
  publicClient: WalletContext["publicClient"],
  wormholeCore: Address,
  expected: number,
): Promise<number> {
  await requireCode(publicClient, wormholeCore, "Wormhole core");
  const actual = await publicClient.readContract({
    address: wormholeCore,
    abi: wormholeAbi,
    functionName: "chainId",
  });
  if (actual !== expected) {
    throw new Error(`Wormhole chain ID mismatch: expected ${expected}, got ${actual}`);
  }
  return actual;
}

async function deployImplementation(
  wallet: WalletContext,
  artifact: GovernanceArtifact,
  label: string,
): Promise<DeployImplementationResult> {
  const { publicClient, walletClient } = wallet;
  const hash = await walletClient.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
    args: [],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) {
    throw new Error(`${label} implementation deployment failed: ${hash}`);
  }

  const code = await requireCode(publicClient, receipt.contractAddress, `${label} implementation`);
  const proxiableUUID = await publicClient.readContract({
    address: receipt.contractAddress,
    abi: artifact.abi,
    functionName: "proxiableUUID",
  });
  if (proxiableUUID !== IMPLEMENTATION_SLOT) {
    throw new Error(`${label} proxiableUUID mismatch: ${proxiableUUID}`);
  }

  return {
    implAddress: receipt.contractAddress,
    deployTxHash: receipt.transactionHash,
    runtimeCodeHash: keccak256(code),
    proxiableUUID: String(proxiableUUID),
  };
}

async function deployProxy(
  wallet: WalletContext,
  implementation: Address,
  initializeData: Hex,
): Promise<{ proxyAddress: Address; deployTxHash: Hex; runtimeCodeHash: Hex }> {
  const { publicClient, walletClient } = wallet;
  await requireCode(publicClient, implementation, "Implementation");

  const artifact = proxyJson as ifs.ContractArtifact;
  const hash = await walletClient.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
    args: [implementation, initializeData],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) {
    throw new Error(`ERC-1967 proxy deployment failed: ${hash}`);
  }

  const configuredImplementation = await implementationOf(publicClient, receipt.contractAddress);
  if (configuredImplementation !== getAddress(implementation)) {
    throw new Error(
      `Proxy implementation mismatch: expected ${implementation}, got ${configuredImplementation}`,
    );
  }
  const code = await requireCode(publicClient, receipt.contractAddress, "ERC-1967 proxy");

  return {
    proxyAddress: receipt.contractAddress,
    deployTxHash: receipt.transactionHash,
    runtimeCodeHash: keccak256(code),
  };
}

export async function deployDispatcherImplementation(
  wallet: WalletContext,
): Promise<DeployImplementationResult> {
  return deployImplementation(
    wallet,
    dispatcherJson as GovernanceArtifact,
    "GovernanceDispatcher",
  );
}

export async function deployExecutorImplementation(
  wallet: WalletContext,
): Promise<DeployImplementationResult> {
  return deployImplementation(wallet, executorJson as GovernanceArtifact, "GovernanceExecutor");
}

export async function deployDispatcherProxy(
  params: DeployDispatcherProxyParams,
): Promise<DeployDispatcherProxyResult> {
  const {
    publicClient,
    implAddress,
    wormholeCore,
    expectedWormholeId,
    governanceCaller,
  } = params;
  const artifact = dispatcherJson as GovernanceArtifact;

  const wormholeId = await readWormholeId(publicClient, wormholeCore, expectedWormholeId);
  const governanceCallerCode = await publicClient.getCode({ address: governanceCaller });
  if (governanceCallerCode && governanceCallerCode !== "0x") {
    throw new Error(`Governance caller unexpectedly has EVM code: ${governanceCaller}`);
  }
  const [governanceCallerNonce, governanceCallerBalance, wormholeMessageFee] = await Promise.all([
    publicClient.getTransactionCount({ address: governanceCaller }),
    publicClient.getBalance({ address: governanceCaller }),
    publicClient.readContract({
      address: wormholeCore,
      abi: wormholeAbi,
      functionName: "messageFee",
    }),
  ]);
  if (governanceCallerNonce !== 0) {
    throw new Error(`Governance caller has nonce history: ${governanceCallerNonce}`);
  }

  const initializeData = encodeFunctionData({
    abi: artifact.abi,
    functionName: "initialize",
    args: [wormholeCore, governanceCaller],
  });
  const deployed = await deployProxy(params, implAddress, initializeData);

  const [configuredWormhole, configuredCaller, nextGovernanceNonce] = await Promise.all([
    publicClient.readContract({
      address: deployed.proxyAddress,
      abi: artifact.abi,
      functionName: "wormhole",
    }),
    publicClient.readContract({
      address: deployed.proxyAddress,
      abi: artifact.abi,
      functionName: "governanceCaller",
    }),
    publicClient.readContract({
      address: deployed.proxyAddress,
      abi: artifact.abi,
      functionName: "nextGovernanceNonce",
    }),
  ]);
  if (getAddress(configuredWormhole as Address) !== getAddress(wormholeCore)) {
    throw new Error(`Dispatcher Wormhole mismatch: ${configuredWormhole}`);
  }
  if (getAddress(configuredCaller as Address) !== getAddress(governanceCaller)) {
    throw new Error(`Dispatcher governance caller mismatch: ${configuredCaller}`);
  }
  if (nextGovernanceNonce !== 1n) {
    throw new Error(`Dispatcher nonce mismatch: ${nextGovernanceNonce}`);
  }

  return {
    ...deployed,
    implAddress,
    wormholeCore: getAddress(wormholeCore),
    wormholeId: String(wormholeId),
    governanceCaller: getAddress(governanceCaller),
    nextGovernanceNonce: String(nextGovernanceNonce),
    governanceCallerBalance: String(governanceCallerBalance),
    governanceCallerNonce: String(governanceCallerNonce),
    wormholeMessageFee: String(wormholeMessageFee),
  };
}

export async function deployExecutorProxy(
  params: DeployExecutorProxyParams,
): Promise<DeployExecutorProxyResult> {
  const {
    publicClient,
    implAddress,
    wormholeCore,
    expectedWormholeId,
    sourceDispatcher,
    vetoer,
    expectedVetoerThreshold,
    expectedVetoerOwnerCount,
    vetoPeriod,
    executionGracePeriod,
  } = params;
  const artifact = executorJson as GovernanceArtifact;

  const wormholeId = await readWormholeId(publicClient, wormholeCore, expectedWormholeId);
  await requireCode(publicClient, vetoer, "Technical Committee Safe");
  const [vetoerThreshold, vetoerOwners] = await Promise.all([
    publicClient.readContract({ address: vetoer, abi: safeAbi, functionName: "getThreshold" }),
    publicClient.readContract({ address: vetoer, abi: safeAbi, functionName: "getOwners" }),
  ]);
  if (vetoerThreshold !== BigInt(expectedVetoerThreshold)) {
    throw new Error(
      `Technical Committee threshold mismatch: expected ${expectedVetoerThreshold}, got ${vetoerThreshold}`,
    );
  }
  if (vetoerOwners.length !== expectedVetoerOwnerCount) {
    throw new Error(
      `Technical Committee owner count mismatch: expected ${expectedVetoerOwnerCount}, got ${vetoerOwners.length}`,
    );
  }

  const sourceDispatcherBytes32 = pad(sourceDispatcher, { size: 32 });
  const initializeData = encodeFunctionData({
    abi: artifact.abi,
    functionName: "initialize",
    args: [
      wormholeCore,
      sourceDispatcherBytes32,
      vetoer,
      vetoPeriod,
      executionGracePeriod,
    ],
  });
  const deployed = await deployProxy(params, implAddress, initializeData);

  const [
    configuredWormhole,
    configuredSourceDispatcher,
    configuredVetoer,
    configuredWormholeId,
    configuredVetoPeriod,
    configuredGracePeriod,
  ] = await Promise.all([
    publicClient.readContract({ address: deployed.proxyAddress, abi: artifact.abi, functionName: "wormhole" }),
    publicClient.readContract({
      address: deployed.proxyAddress,
      abi: artifact.abi,
      functionName: "sourceDispatcher",
    }),
    publicClient.readContract({ address: deployed.proxyAddress, abi: artifact.abi, functionName: "vetoer" }),
    publicClient.readContract({
      address: deployed.proxyAddress,
      abi: artifact.abi,
      functionName: "localWormholeChain",
    }),
    publicClient.readContract({ address: deployed.proxyAddress, abi: artifact.abi, functionName: "vetoPeriod" }),
    publicClient.readContract({
      address: deployed.proxyAddress,
      abi: artifact.abi,
      functionName: "executionGracePeriod",
    }),
  ]);

  if (getAddress(configuredWormhole as Address) !== getAddress(wormholeCore)) {
    throw new Error(`Executor Wormhole mismatch: ${configuredWormhole}`);
  }
  if (String(configuredSourceDispatcher).toLowerCase() !== sourceDispatcherBytes32.toLowerCase()) {
    throw new Error(`Executor source dispatcher mismatch: ${configuredSourceDispatcher}`);
  }
  if (getAddress(configuredVetoer as Address) !== getAddress(vetoer)) {
    throw new Error(`Executor vetoer mismatch: ${configuredVetoer}`);
  }
  if (configuredWormholeId !== expectedWormholeId) {
    throw new Error(`Executor Wormhole ID mismatch: ${configuredWormholeId}`);
  }
  if (configuredVetoPeriod !== vetoPeriod) {
    throw new Error(`Executor veto period mismatch: ${configuredVetoPeriod}`);
  }
  if (configuredGracePeriod !== executionGracePeriod) {
    throw new Error(`Executor grace period mismatch: ${configuredGracePeriod}`);
  }

  return {
    ...deployed,
    implAddress,
    wormholeCore: getAddress(wormholeCore),
    wormholeId: String(wormholeId),
    sourceDispatcher: getAddress(sourceDispatcher),
    sourceDispatcherBytes32,
    vetoer: getAddress(vetoer),
    vetoerThreshold: String(vetoerThreshold),
    vetoerOwners: vetoerOwners.map((owner) => getAddress(owner)).join(","),
    vetoPeriod: String(configuredVetoPeriod),
    executionGracePeriod: String(configuredGracePeriod),
  };
}
