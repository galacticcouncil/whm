import { OneClickService } from "@defuse-protocol/one-click-sdk-typescript";

/**
 * Notify 1Click that a deposit landed at `depositAddress` in `txHash`.
 *
 * @param depositAddress OneClick quote deposit address that received the funds.
 * @param txHash         Ethereum tx hash that forwarded the deposit.
 * @returns The 1Click submit response (carries the resulting status).
 */
export function submitDeposit(depositAddress: string, txHash: string) {
  return OneClickService.submitDepositTx({ depositAddress, txHash });
}
