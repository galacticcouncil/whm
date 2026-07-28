/**
 * Redeem the 11 moxit VAAs on their target chains via the Wormhole v4 SDK (unified redeem).
 * Reuses whm's fetchVaaHex. Permissionless: recipient is fixed in each VAA (TC multisigs); the
 * signer only pays gas. Only legs whose key is provided are attempted, so you can start EVM-only.
 *
 *   pnpm add @wormhole-foundation/sdk       # (already added)
 *   EVM_KEY=0x…  SOLANA_KEYPAIR=~/key.json (or SOLANA_KEY=<base58>)  SUI_KEY=suiprivkey…  \
 *   [ETH_RPC=… BASE_RPC=… SOLANA_RPC=… SUI_RPC=…] [ONLY=96893] \
 *     pnpm tsx chopsticks/probes/redeemAll.ts
 */
import { wormhole, signSendWait, deserialize, Wormhole, encoding } from "@wormhole-foundation/sdk";
import evm from "@wormhole-foundation/sdk/evm";
import solana from "@wormhole-foundation/sdk/solana";
import sui from "@wormhole-foundation/sdk/sui";
import { getEvmSignerForKey } from "@wormhole-foundation/sdk-evm";
import { getSolanaSignAndSendSigner } from "@wormhole-foundation/sdk-solana";
import { getSuiSigner } from "@wormhole-foundation/sdk-sui";
import { Keypair } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { fetchVaaHex } from "../../common/wormhole/scan";

/** Solana secret from SOLANA_KEYPAIR (path to [n,n,…] json or a base58 string in a file) or SOLANA_KEY (base58). */
function solanaSecret(): string | Keypair | undefined {
  const path = process.env.SOLANA_KEYPAIR;
  if (path) {
    const raw = readFileSync(path, "utf8").trim();
    if (raw.startsWith("[")) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
    return raw; // base58 string in a file
  }
  return process.env.SOLANA_KEY;
}
const SOL_SECRET = solanaSecret();

const EMITTER = "000000000000000000000000b1731c586ca89a23809861c6103f0b96b3f57d92";
type Chain = "Ethereum" | "Base" | "Solana" | "Sui";
const JOBS: { seq: bigint; sym: string; chain: Chain }[] = [
  { seq: 96893n, sym: "DAI",     chain: "Ethereum" }, { seq: 96894n, sym: "WBTC", chain: "Ethereum" },
  { seq: 96895n, sym: "WETH",    chain: "Ethereum" }, { seq: 96896n, sym: "USDC", chain: "Ethereum" },
  { seq: 96897n, sym: "USDT",    chain: "Ethereum" }, { seq: 96901n, sym: "sUSDS", chain: "Ethereum" },
  { seq: 96900n, sym: "EURC",    chain: "Base" },
  { seq: 96898n, sym: "jitoSOL", chain: "Solana" },   { seq: 96899n, sym: "PRIME", chain: "Solana" },
  { seq: 96902n, sym: "SOL",     chain: "Solana" },
  { seq: 96903n, sym: "SUI",     chain: "Sui" },
];

const RPC: Partial<Record<Chain, string>> = {
  Ethereum: process.env.ETH_RPC, Base: process.env.BASE_RPC,
  Solana: process.env.SOLANA_RPC, Sui: process.env.SUI_RPC,
};
const KEY: Record<Chain, unknown> = {
  Ethereum: process.env.EVM_KEY, Base: process.env.EVM_KEY,
  Solana: SOL_SECRET, Sui: process.env.SUI_KEY,
};

async function main() {
  const cfg: any = { chains: {} };
  for (const [c, url] of Object.entries(RPC)) if (url) cfg.chains[c] = { rpc: url };
  const wh = await wormhole("Mainnet", [evm, solana, sui], cfg);

  const signerCache: Partial<Record<Chain, any>> = {};
  async function signerFor(c: Chain) {
    if (signerCache[c]) return signerCache[c];
    const chain = wh.getChain(c); const rpc = await chain.getRpc();
    let s;
    if (c === "Ethereum" || c === "Base") s = await getEvmSignerForKey(rpc as any, KEY[c] as string);
    else if (c === "Solana") s = await getSolanaSignAndSendSigner(rpc as any, SOL_SECRET as any);
    else s = await getSuiSigner(rpc as any, KEY.Sui as string);
    signerCache[c] = s; return s;
  }

  const only = process.env.ONLY ? BigInt(process.env.ONLY) : null;
  for (const j of JOBS) {
    if (only && j.seq !== only) continue;
    if (!KEY[j.chain]) { console.log(`  ${j.sym.padEnd(8)} skip — no key for ${j.chain}`); continue; }
    try {
      const chain = wh.getChain(j.chain);
      const tb = await chain.getTokenBridge();
      const vaa = deserialize("TokenBridge:Transfer", encoding.hex.decode(await fetchVaaHex(16, EMITTER, j.seq)));
      if (await tb.isTransferCompleted(vaa)) { console.log(`  ${j.sym.padEnd(8)} already redeemed`); continue; }
      const signer = await signerFor(j.chain);
      const sender = Wormhole.chainAddress(chain.chain, signer.address());
      const isEvm = j.chain === "Ethereum" || j.chain === "Base";
      const xfer = isEvm ? tb.redeem(sender.address, vaa, false) : tb.redeem(sender.address, vaa); // unwrapNative=false → WETH as ERC20
      const txids = await signSendWait(chain, xfer, signer);
      console.log(`  ${j.sym.padEnd(8)} ✅ redeemed on ${j.chain}: ${txids.at(-1)?.txid}`);
    } catch (e: any) {
      console.log(`  ${j.sym.padEnd(8)} ❌ ${e?.message ?? e}`);
    }
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
