import { Account, JsonRpcProvider, KeyPairSigner, type KeyPairString } from "near-api-js";

/**
 * A NEAR account that signs with a single key, and the provider it sends through.
 *
 * @param rpcUrl NEAR JSON-RPC endpoint
 * @param accountId The signing account, e.g. `whm.near`
 * @param privateKey Its secret key, `ed25519:…`
 * @returns The provider (views), the signer and the account (transactions)
 */
export function getWallet(rpcUrl: string, accountId: string, privateKey: string) {
  const provider = new JsonRpcProvider({ url: rpcUrl });
  const signer = KeyPairSigner.fromSecretKey(privateKey as KeyPairString);
  const account = new Account(accountId, provider, signer);

  return { provider, signer, account };
}

export type NearWallet = ReturnType<typeof getWallet>;
