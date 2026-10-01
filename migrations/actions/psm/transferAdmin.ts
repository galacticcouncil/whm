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
 *
 * Idempotent on resume: if the handover already landed, nothing is sent — the grant would
 * otherwise revert on every re-run, since the deployer no longer holds the role (a renounce by a
 * non-holder is a silent no-op).
 */
export type TransferAdminParams = WalletContext & {
  contract: `0x${string}`;
  newAdmin: `0x${string}`;
  /**
   * Refuse an admin with no code. On for the vault, whose admin must be the Safe and never an
   * EOA; off for the facilitator, whose admin is Hydration's technical-committee account — a
   * pallet-derived H160 that has no code by construction.
   */
  requireContract?: boolean;
};

export type TransferAdminResult = {
  grantTxHash: string;
  renounceTxHash: string;
  contract: string;
  newAdmin: string;
  renouncedBy: string;
  /** Set on a resumed run that found the handover already done; the original hashes were never saved. */
  verifiedAtBlock?: string;
};

export async function transferAdmin(params: TransferAdminParams): Promise<TransferAdminResult> {
  const { publicClient, walletClient, account, contract, newAdmin, requireContract } = params;
  // Both PSM contracts inherit this, so the shared base's ABI covers either side.
  const { abi } = accessControlJson as ifs.ContractArtifact;

  // Either of these, followed by the renounce, would leave the contract adminless.
  if (newAdmin.toLowerCase() === account.address.toLowerCase()) {
    throw new Error(`transferAdmin: new admin ${newAdmin} is the deployer itself.`);
  }
  if (/^0x0{40}$/i.test(newAdmin)) {
    throw new Error("transferAdmin: new admin is the zero address.");
  }
  if (requireContract) {
    const code = await publicClient.getCode({ address: newAdmin });
    if (!code || code === "0x") {
      throw new Error(`transferAdmin: ${newAdmin} has no code; this admin must be a contract.`);
    }
  }

  const hasRole = async (who: `0x${string}`) =>
    (await publicClient.readContract({
      address: contract,
      abi,
      functionName: "hasRole",
      args: [DEFAULT_ADMIN_ROLE, who],
    })) as boolean;

  if ((await hasRole(newAdmin)) && !(await hasRole(account.address))) {
    return {
      grantTxHash: "already-transferred",
      renounceTxHash: "already-transferred",
      contract,
      newAdmin,
      renouncedBy: account.address,
      verifiedAtBlock: (await publicClient.getBlockNumber()).toString(),
    };
  }

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
