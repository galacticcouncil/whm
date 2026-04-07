import "dotenv/config";

import * as anchor from "@coral-xyz/anchor";

import { args } from "@whm/common";

const { requiredEnv, requiredArg } = args;
const { PublicKey, Connection, LAMPORTS_PER_SOL } = anchor.web3;

const address = requiredArg("--address");
const rpcUrl = requiredEnv("RPC_URL");

const connection = new Connection(rpcUrl, "confirmed");
const pubkey = new PublicKey(address);
const balance = await connection.getBalance(pubkey);

console.log("Address:", pubkey.toBase58());
console.log("Balance:", balance / LAMPORTS_PER_SOL, "SOL");
