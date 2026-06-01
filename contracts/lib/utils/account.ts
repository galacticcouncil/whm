import { mnemonicToAccount } from "viem/accounts";

export function mnemonicToAccountByAddress(mnemonic: string, address: string, max = 100) {
  const target = address.toLowerCase();
  for (let i = 0; i < max; i++) {
    const account = mnemonicToAccount(mnemonic, { addressIndex: i });
    if (account.address.toLowerCase() === target) return account;
  }
  throw new Error(`Address ${address} not found in first ${max} indices`);
}
