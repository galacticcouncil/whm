import { AccountId } from "polkadot-api";
import { h160, hex } from "@galacticcouncil/common/utils";

export interface AddressCandidates {
  sender: string | null;
  recipient: string[];
}

export function addressCandidates(input: string): AddressCandidates {
  const s = input.trim();

  if (h160.isEvmAddress(s)) {
    const lower = s.toLowerCase();
    const padded = "0x" + "0".repeat(24) + lower.slice(2);
    return { sender: lower, recipient: [padded] };
  }

  if (hex.isHex(s) && s.length === 66) {
    return { sender: null, recipient: [s.toLowerCase()] };
  }

  if (h160.isSs58Address(s)) {
    const pubkey = AccountId().enc(s);
    const asHex = "0x" + Buffer.from(pubkey).toString("hex");
    return { sender: null, recipient: [asHex] };
  }

  return { sender: null, recipient: [] };
}
