/**
 * Redeem the 17 protocol-migration VAAs (seq 96938–96954) on their target chains via Wormhole v4 SDK.
 * Recipients are fixed in each VAA (TC multisigs); the signer only pays gas. Only legs whose key is
 * provided are attempted. isTransferCompleted guard prevents replay. The 6 big remainders
 * (96949–96954) may be Governor-enqueued (~24h) and simply error until their VAA is signed/available.
 *
 *   EVM_KEY=0x…  SOLANA_KEYPAIR=~/key.json (or SOLANA_KEY=<base58>)  SUI_KEY=suiprivkey…  \
 *   [ETH_RPC=… BASE_RPC=… SOLANA_RPC=… SUI_RPC=…] [ONLY=96938] \
 *     pnpm tsx chopsticks/probes/redeemMigration.ts
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

function solanaSecret(): string | Keypair | undefined {
  const path = process.env.SOLANA_KEYPAIR;
  if (path) {
    const raw = readFileSync(path, "utf8").trim();
    if (raw.startsWith("[")) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
    return raw;
  }
  return process.env.SOLANA_KEY;
}
const SOL_SECRET = solanaSecret();

const EMITTER = "000000000000000000000000b1731c586ca89a23809861c6103f0b96b3f57d92";
type Chain = "Ethereum" | "Base" | "Solana" | "Sui";
// seq → asset/chain, in batch order (11 immediate legs, then 6 big remainders). Verified against
// on-chain VAA amounts + toChain 2026-07-29.
const JOBS: { seq: bigint; sym: string; chain: Chain; leg: string }[] = [
  { seq: 96938n, sym: "DAI",     chain: "Ethereum", leg: "immediate" },
  { seq: 96939n, sym: "WBTC",    chain: "Ethereum", leg: "immediate" },
  { seq: 96940n, sym: "WETH",    chain: "Ethereum", leg: "immediate" },
  { seq: 96941n, sym: "USDC",    chain: "Ethereum", leg: "immediate" },
  { seq: 96942n, sym: "USDT",    chain: "Ethereum", leg: "immediate" },
  { seq: 96943n, sym: "jitoSOL", chain: "Solana",   leg: "immediate" },
  { seq: 96944n, sym: "PRIME",   chain: "Solana",   leg: "immediate" },
  { seq: 96945n, sym: "EURC",    chain: "Base",     leg: "immediate" },
  { seq: 96946n, sym: "sUSDS",   chain: "Ethereum", leg: "immediate" },
  { seq: 96947n, sym: "SOL",     chain: "Solana",   leg: "immediate" },
  { seq: 96948n, sym: "SUI",     chain: "Sui",      leg: "immediate" },
  { seq: 96949n, sym: "WBTC",    chain: "Ethereum", leg: "remainder" },
  { seq: 96950n, sym: "USDC",    chain: "Ethereum", leg: "remainder" },
  { seq: 96951n, sym: "USDT",    chain: "Ethereum", leg: "remainder" },
  { seq: 96952n, sym: "PRIME",   chain: "Solana",   leg: "remainder" },
  { seq: 96953n, sym: "EURC",    chain: "Base",     leg: "remainder" },
  { seq: 96954n, sym: "SOL",     chain: "Solana",   leg: "remainder" },
];

const RPC: Partial<Record<Chain, string>> = {
  Ethereum: process.env.ETH_RPC, Base: process.env.BASE_RPC,
  Solana: process.env.SOLANA_RPC, Sui: process.env.SUI_RPC,
};
const KEY: Record<Chain, unknown> = {
  Ethereum: process.env.EVM_KEY, Base: process.env.EVM_KEY,
  Solana: SOL_SECRET, Sui: process.env.SUI_KEY,
};
// ONLY_LEG=immediate  → skip the big remainders (recommended for the first pass, before the ~24h clears)
const ONLY_LEG = process.env.ONLY_LEG;

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
    if (ONLY_LEG && j.leg !== ONLY_LEG) continue;
    if (!KEY[j.chain]) { console.log(`  ${j.sym.padEnd(8)} ${j.leg.padEnd(9)} skip — no key for ${j.chain}`); continue; }
    try {
      const chain = wh.getChain(j.chain);
      const tb = await chain.getTokenBridge();
      const vaa = deserialize("TokenBridge:Transfer", encoding.hex.decode(await fetchVaaHex(16, EMITTER, j.seq)));
      if (await tb.isTransferCompleted(vaa)) { console.log(`  ${j.sym.padEnd(8)} ${j.leg.padEnd(9)} already redeemed`); continue; }
      const signer = await signerFor(j.chain);
      const sender = Wormhole.chainAddress(chain.chain, signer.address());
      const noUnwrap = j.chain !== "Sui"; // don't unwrap native: WETH → ERC20, wSOL → the vault ATA
      const xfer = noUnwrap ? tb.redeem(sender.address, vaa, false) : tb.redeem(sender.address, vaa);
      const txids = await signSendWait(chain, xfer, signer);
      console.log(`  ${j.sym.padEnd(8)} ${j.leg.padEnd(9)} ✅ ${j.chain}: ${txids.at(-1)?.txid}`);
    } catch (e: any) {
      console.log(`  ${j.sym.padEnd(8)} ${j.leg.padEnd(9)} ❌ ${(e?.message ?? e).toString().slice(0, 140)}`);
    }
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
