import { optional } from "../../env";

export const APP_NAME = "api";

/** rpc.mainnet.near.org is deprecated and throttles; fastnear is the free default. */
export const RPC_NEAR = optional("RPC_NEAR", "https://free.rpc.fastnear.com");
