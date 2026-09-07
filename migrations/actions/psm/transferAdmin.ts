import type { ifs } from "@whm/common/evm";
import type { WalletContext } from "../types";

import accessControlJson from "../../../contracts/out-psm/AccessControlUpgradeable.sol/AccessControlUpgradeable.json";

const DEFAULT_ADMIN_ROLE =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

/**
 * Hand DEFAULT_ADMIN_ROLE to its permanent holder and drop the deployer's.
 *
 * Two transactions, in this order, and the second is the one that matters: leaving the deployer
 * key with admin would leave a second path to the upgrade function, which on the Base side is a
 * path to the whole reserve. Grant first so the contract is never adminless in between.
 */
export type TransferAdminParams = WalletContext & {
  contract: `0x${string}`;
  newAdmin: `0x${string}`;
};

export type TransferAdminResult = {
  grantTxHash: string;
  renounceTxHash: string;
  contract: string;
  newAdmin: string;
  renouncedBy: string;
};

export async function transferAdmin(params: TransferAdminParams): Promise<TransferAdminResult> {
  const { publicClient, walletClient, account, contract, newAdmin } = params;
  // Both PSM contracts inherit this, so the shared base's ABI covers either side.
  const { abi } = accessControlJson as ifs.ContractArtifact;

  const grantTxHash = await walletClient.writeContract({
    address: contract,
    abi,
    functionName: "grantRole",
    args: [DEFAULT_ADMIN_ROLE, newAdmin],
  });
  await publicClient.waitForTransactionReceipt({ hash: grantTxHash });

  const renounceTxHash = await walletClient.writeContract({
    address: contract,
    abi,
    functionName: "renounceRole",
    args: [DEFAULT_ADMIN_ROLE, account.address],
  });
  await publicClient.waitForTransactionReceipt({ hash: renounceTxHash });

  return {
    grantTxHash,
    renounceTxHash,
    contract,
    newAdmin,
    renouncedBy: account.address,
  };
}
