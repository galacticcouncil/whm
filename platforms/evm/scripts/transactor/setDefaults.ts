import "dotenv/config";

import { isAddress } from "viem";

import { args } from "@whm/common";
import { ifs, wallet } from "../../lib";

import xcmTransactorJson from "../../contracts/out/XcmTransactor.sol/XcmTransactor.json";

const { requiredArg, requiredEnv } = args;
const { getWallet } = wallet;

const UINT64_MAX = (1n << 64n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;

function parseUint(value: string, argName: string, max: bigint): bigint {
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw new Error(`Invalid ${argName} (expected unsigned integer).`);
  }

  if (parsed < 0n || parsed > max) {
    throw new Error(`Invalid ${argName} (out of range).`);
  }

  return parsed;
}

function getConfig() {
  const rpcUrl = requiredEnv("RECEIVER_RPC");
  const chainId = requiredEnv("RECEIVER_CHAIN_ID");

  const privateKey = requiredArg("--pk");
  const address = requiredArg("--address");

  const gasLimit = parseUint(requiredArg("--gas-limit"), "--gas-limit", UINT64_MAX);
  const maxFeePerGas = parseUint(
    requiredArg("--max-fee-per-gas"),
    "--max-fee-per-gas",
    UINT256_MAX,
  );
  const transactWeight = parseUint(
    requiredArg("--transact-weight"),
    "--transact-weight",
    UINT64_MAX,
  );
  const transactProofSize = parseUint(
    requiredArg("--transact-proof-size"),
    "--transact-proof-size",
    UINT64_MAX,
  );
  const feeAmount = parseUint(requiredArg("--fee-amount"), "--fee-amount", UINT256_MAX);

  if (!isAddress(address)) throw new Error("Invalid transactor address.");

  return {
    rpcUrl,
    chainId: Number(chainId),
    address: address as `0x${string}`,
    privateKey: privateKey as `0x${string}`,
    gasLimit,
    maxFeePerGas,
    transactWeight,
    transactProofSize,
    feeAmount,
  };
}

async function main(): Promise<void> {
  const {
    address,
    rpcUrl,
    chainId,
    privateKey,
    gasLimit,
    maxFeePerGas,
    transactWeight,
    transactProofSize,
    feeAmount,
  } = getConfig();

  const { publicClient, walletClient } = getWallet(rpcUrl, chainId, privateKey);

  const { abi } = xcmTransactorJson as ifs.ContractArtifact;

  const txHash = await walletClient.writeContract({
    address: address,
    abi,
    functionName: "setXcmDefaults",
    args: [gasLimit, maxFeePerGas, transactWeight, transactProofSize, feeAmount],
  });

  await publicClient.waitForTransactionReceipt({ hash: txHash });
  console.log("XCM defaults updated:", address);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
