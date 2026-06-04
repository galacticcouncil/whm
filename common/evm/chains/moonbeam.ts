import { Chain, defineChain } from "viem";

export const moonbeam: Chain = defineChain({
  id: 1284,
  name: "Moonbeam",
  network: "moonbeam",
  nativeCurrency: {
    decimals: 18,
    name: "GLMR",
    symbol: "GLMR",
  },
  rpcUrls: {
    default: {
      http: ["https://rpc.api.moonbeam.network"],
    },
  },
  blockExplorers: {
    default: {
      name: "Moonscan",
      url: "https://moonscan.io",
    },
    etherscan: {
      name: "Moonscan",
      url: "https://moonscan.io",
    },
  },
  testnet: false,
});
