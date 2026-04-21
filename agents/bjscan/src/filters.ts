import { h160 } from "@galacticcouncil/common/utils";
export interface AddressCandidates {
  sender: string | null;
  recipient: string[];
}

export function addressFilter(input: string): AddressCandidates {
  const s = input.trim();

  if (h160.isEvmAddress(s)) {
    const lower = s.toLowerCase();
    return { sender: lower, recipient: [lower] };
  }

  if (h160.isSs58Address(s)) {
    const lower = s.toLowerCase();
    return { sender: null, recipient: [lower] };
  }

  return { sender: null, recipient: [] };
}
