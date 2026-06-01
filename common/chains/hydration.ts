import { Chain, defineChain } from "viem";

export const hydration: Chain = defineChain({
  id: 222222,
  name: "Hydration",
  network: "hydration",
  nativeCurrency: {
    decimals: 18,
    name: "WETH",
    symbol: "WETH",
  },
  rpcUrls: {
    default: {
      http: ["https://rpc.hydradx.cloud/evm"],
    },
  },
  blockExplorers: {
    default: {
      name: "Hydration Explorer",
      url: "https://explorer.hydration.cloud",
    },
  },
  testnet: false,
});