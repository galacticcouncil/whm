import { Redis } from "ioredis";
import { JsonRpcProvider } from "near-api-js";

import { signer } from "../../near/client";

import { near, redis as redisCfg } from "./config";

export const provider = new JsonRpcProvider({ url: near.rpcUrl });

/** Pays the gas, the 1 yocto per call and each new account's creation. */
export const account = signer(provider, near.accountId, near.privateKey);

export const redis = new Redis({ host: redisCfg.host, port: redisCfg.port });
