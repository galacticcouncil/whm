import { isAddress } from "viem";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}.`);
  return v;
}

function requiredAddress(name: string): `0x${string}` {
  const v = required(name);
  if (!isAddress(v)) throw new Error(`${name} is not a valid address: ${v}`);
  return v;
}

export const source = {
  name: "ethereum",
  wssUrl: required("ETH_WSS"),
  receiver: requiredAddress("INTENT_RECEIVER"),
};

export const port = Number(process.env.PORT ?? 8080);
