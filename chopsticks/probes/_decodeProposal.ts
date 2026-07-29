/** Decode the migration proposal's EVM legs straight from the call bytes (no chain needed).
 *  Scans for approve (095ea7b3) + transferTokens (0f5287b0) calldata and ABI-decodes each.
 *  Usage: pnpm tsx probes/_decodeProposal.ts [0x<hex>]   (defaults to rescue-proposal.json innerBatchAll) */
import { readFileSync } from "node:fs";
import { decodeFunctionData, parseAbi, getAddress, type Hex } from "viem";
import { ASSETS } from "./exitAssets";

const ABI = parseAbi([
  "function approve(address spender, uint256 amount)",
  "function transferTokens(address token, uint256 amount, uint16 recipientChain, bytes32 recipient, uint256 arbiterFee, uint32 nonce)",
]);
const CH: Record<number, string> = { 1: "Solana", 2: "Ethereum", 21: "Sui", 30: "Base" };
const byToken: Record<string, { sym: string; decimals: number }> = {};
for (const a of ASSETS) byToken[a.token.toLowerCase()] = { sym: a.sym, decimals: a.decimals };

function scan(hex: string, selector: string, words: number) {
  const out: string[] = []; let i = 0;
  const need = 8 + words * 64;
  while ((i = hex.indexOf(selector, i)) !== -1) { out.push("0x" + hex.slice(i, i + need)); i += 8; }
  return out;
}
const human = (amt: bigint, d: number) => Number(amt) / 10 ** d;

function main() {
  const d = JSON.parse(readFileSync("probes/rescue-proposal.json", "utf8"));
  const raw = (process.argv[2] ?? d.innerBatchAll).toLowerCase().replace(/^0x/, "");
  const transfers = scan(raw, "0f5287b0", 6);
  const approves = scan(raw, "095ea7b3", 2);

  console.log(`outer (SCALE, Hydration): Utility.batch_all([ PolkadotXcm.send × ${transfers.length} ])`);
  console.log(`  each send: dest = Parachain(2004 Moonbeam); Xcm.Transact{SovereignAccount} → approve + transferTokens\n`);
  console.log(`found ${approves.length} approve + ${transfers.length} transferTokens calls\n`);
  console.log(`${"#".padStart(2)}  ${"asset".padEnd(8)} ${"token".padEnd(12)} ${"amount".padStart(16)} ${"→ chain".padEnd(9)} recipient`);
  console.log("-".repeat(120));

  let tot = 0, n = 0;
  for (const cd of transfers) {
    const { args } = decodeFunctionData({ abi: ABI, data: cd as Hex });
    const [token, amount, chain, recipient] = args as unknown as [string, bigint, number, Hex];
    const meta = byToken[token.toLowerCase()] ?? { sym: "?", decimals: 18 };
    const h = human(amount, meta.decimals); n++;
    // solana/sui recipients are raw 32-byte; evm are left-padded 20-byte
    const isEvm = chain === 2 || chain === 30;
    const rcpt = isEvm ? getAddress(("0x" + recipient.slice(-40)) as Hex) : recipient;
    console.log(`${String(n).padStart(2)}  ${meta.sym.padEnd(8)} ${(token.slice(0, 10) + "…").padEnd(12)} ${h.toLocaleString(undefined, { maximumFractionDigits: 4 }).padStart(16)} ${(CH[chain] ?? String(chain)).padEnd(9)} ${rcpt}`);
  }
  console.log("-".repeat(120));
  // sanity: approve amount must equal transferTokens amount for each leg (same order)
  let mism = 0;
  for (let i = 0; i < transfers.length; i++) {
    const t = decodeFunctionData({ abi: ABI, data: transfers[i] as Hex }).args as any;
    const a = decodeFunctionData({ abi: ABI, data: approves[i] as Hex }).args as any;
    if (t[1] !== a[1]) mism++;
  }
  console.log(`approve==transfer amount per leg: ${mism === 0 ? "✅ all match" : `❌ ${mism} mismatched`}`);
}
main();
