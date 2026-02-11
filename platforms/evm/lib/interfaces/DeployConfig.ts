import { HDAccount, PrivateKeyAccount } from "viem";

export type DeployerAccount = PrivateKeyAccount | HDAccount;

export type ReceiverConfig = {
  account: DeployerAccount;
  rpcUrl: string;
  relayer: `0x${string}`;
  sender: `0x${string}`;
  sourceChainId: number;
};

export type SenderConfig = {
  account: DeployerAccount;
  rpcUrl: string;
  relayer: `0x${string}`;
};

export type SendConfig = {
  account: DeployerAccount;
  rpcUrl: string;
  senderAddress: `0x${string}`;
  receiverAddress: `0x${string}`;
  targetChainId: number;
  message: string;
};
