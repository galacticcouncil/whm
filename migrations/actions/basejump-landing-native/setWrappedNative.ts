import type { ifs } from "@whm/common/evm";
import type { WalletContext } from "../types";

import basejumpLandingNativeJson from "../../../contracts/out/BasejumpLandingNative.sol/BasejumpLandingNative.json";

export type SetWrappedNativeParams = WalletContext & {
  basejumpLandingAddress: `0x${string}`;
  wrappedNative: `0x${string}`;
};

export type SetWrappedNativeResult = {
  txHash: string;
  wrappedNative: string;
};

/** Set the wrapped-native token (e.g. WETH) the landing unwraps to satisfy NATIVE payouts. */
export async function setWrappedNative(
  params: SetWrappedNativeParams,
): Promise<SetWrappedNativeResult> {
  const { publicClient, walletClient, basejumpLandingAddress, wrappedNative } = params;
  const { abi } = basejumpLandingNativeJson as ifs.ContractArtifact;

  const txHash = await walletClient.writeContract({
    address: basejumpLandingAddress,
    abi,
    functionName: "setWrappedNative",
    args: [wrappedNative],
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });

  return { txHash, wrappedNative };
}
