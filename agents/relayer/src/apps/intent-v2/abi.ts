import { parseAbi } from "viem";

/** IntentForwarder — the destination call, the startup reads, and the reverts worth naming in logs. */
export const forwarderAbi = parseAbi([
  "function processOrder(bytes nttVaa, uint256 feeRequested) external",
  "function dispatcher() view returns (bytes32)",
  "function authorizedRelayer(address relayer) view returns (bool)",
  "function authorizedRelayerCount() view returns (uint256)",
  "error NotConfigured()",
  "error AlreadyRedeemed()",
  "error SettlementNotReleased(uint64 sequence)",
  "error UnexpectedTrim(uint8 decimals)",
  "error FeeExceedsCeiling()",
  "error Unauthorized()",
  "error UnexpectedSourceChain(uint16 chainId)",
  "error UnauthorizedSender(bytes32 sender)",
  "error WrongRecipient(bytes32 to)",
  "error NativeTransferFailed()",
  "error MalformedForward(uint256 length)",
]);
