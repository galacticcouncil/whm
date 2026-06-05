import "dotenv/config";

import { isAddress, isHex, keccak256, encodePacked } from "viem";

import { args } from "@whm/common";
import { ifs, wallet } from "@whm/common/evm";

import intentEmitterJson from "../../out/IntentEmitter.sol/IntentEmitter.json";

const { requiredArg, optionalArg, requiredEnv } = args;
const { getWallet } = wallet;

// Hydration asset id → ERC20-precompile address: 0x0100000000 | assetId.
function assetErc20(assetId: number): `0x${string}` {
  const v = (1n << 32n) + BigInt(assetId);
  return ("0x" + v.toString(16).padStart(40, "0")) as `0x${string}`;
}

function getConfig() {
  const rpcUrl = requiredEnv("RPC");
  const chainId = requiredEnv("CHAIN_ID");

  const privateKey = requiredArg("--pk");
  const address = requiredArg("--address"); // IntentEmitter proxy
  const assetIn = Number(requiredArg("--assetIn")); // Hydration asset id (e.g. DOT=5)
  const amountIn = BigInt(requiredArg("--amountIn")); // total A pulled from caller
  const minEthOut = BigInt(requiredArg("--minEthOut")); // slippage floor on WETH out
  const depositAddress = requiredArg("--depositAddress"); // OneClick deposit addr (Ethereum)
  const intentIdArg = optionalArg("--intentId");

  if (!isAddress(address)) throw new Error("Invalid --address (IntentEmitter).");
  if (!isAddress(depositAddress)) throw new Error("Invalid --depositAddress.");
  if (!Number.isInteger(assetIn) || assetIn < 0) throw new Error("Invalid --assetIn (asset id).");
  if (intentIdArg && (!isHex(intentIdArg) || intentIdArg.length !== 66))
    throw new Error("Invalid --intentId (expected bytes32).");

  const intentId =
    (intentIdArg as `0x${string}`) ??
    keccak256(encodePacked(["address", "uint256"], [depositAddress as `0x${string}`, amountIn]));

  return {
    rpcUrl,
    chainId: Number(chainId),
    privateKey: privateKey as `0x${string}`,
    address: address as `0x${string}`,
    assetIn,
    amountIn,
    minEthOut,
    depositAddress: depositAddress as `0x${string}`,
    intentId,
  };
}

const erc20Abi = [
  {
    name: "approve",
    type: "function",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    name: "balanceOf",
    type: "function",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

async function main(): Promise<void> {
  const cfg = getConfig();
  const { publicClient, walletClient, account } = getWallet(cfg.rpcUrl, cfg.chainId, cfg.privateKey);
  const { abi } = intentEmitterJson as ifs.ContractArtifact;

  const assetToken = assetErc20(cfg.assetIn);

  console.log("IntentEmitter:", cfg.address);
  console.log("caller:       ", account.address);
  console.log("assetIn:      ", cfg.assetIn, "->", assetToken);
  console.log("amountIn:     ", cfg.amountIn.toString());
  console.log("minEthOut:    ", cfg.minEthOut.toString());
  console.log("depositAddr:  ", cfg.depositAddress);
  console.log("intentId:     ", cfg.intentId);

  const bal = (await publicClient.readContract({
    address: assetToken,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account.address],
  })) as bigint;
  console.log("assetIn balance:", bal.toString());
  if (bal < cfg.amountIn) throw new Error(`Insufficient assetIn: have ${bal}, need ${cfg.amountIn}`);

  // 1. Approve the emitter to pull amountIn of assetIn.
  const approveHash = await walletClient.writeContract({
    address: assetToken,
    abi: erc20Abi,
    functionName: "approve",
    args: [cfg.address, cfg.amountIn],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });
  console.log("approved:", approveHash);

  // 2. swapAndBridge(assetIn, amountIn, minEthOut, intentId, depositAddress)
  const hash = await walletClient.writeContract({
    address: cfg.address,
    abi,
    functionName: "swapAndBridge",
    args: [cfg.assetIn, cfg.amountIn, cfg.minEthOut, cfg.intentId, cfg.depositAddress],
  });
  console.log("swapAndBridge tx:", hash);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log("status:", receipt.status, "block:", receipt.blockNumber);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
