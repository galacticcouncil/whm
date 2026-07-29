/** DECIMALS/AMOUNT probe — fork Hydration+Moonbeam, cross-check per asset:
 *   moonbeam ERC20 decimals()  ==  hydration assetRegistry decimals  ==  exitAssets cfg decimals
 *   and  amountRaw / 10^decimals  ==  intended protocol-owned tokens,  and  amountRaw <= SA balance. */
import { getAddress, createPublicClient, http, erc20Abi, type Hex, type PublicClient } from "viem";
import { configs } from "../lib/configs";
import { spawnForks, teardownForks } from "../lib/network";
import { acc } from "@galacticcouncil/common";
import { ASSETS } from "./exitAssets";
import { rescueRaw, PROTOCOL_OWNED } from "./rescueAmounts";

const SA = getAddress(acc.getSovereignAccounts(2034).moonbeam as Hex);
const fmt = (x: bigint, d: number) => (Number(x) / 10 ** d);

async function main() {
  const nets = await spawnForks([configs.hydration, configs.moonbeam]);
  const { hydration, moonbeam } = nets;
  try {
    const hyd = hydration.client.getUnsafeApi();
    const eth = createPublicClient({ transport: http(`http://127.0.0.1:${configs.moonbeam.port}`) }) as PublicClient;

    console.log(`SA ${SA}\n`);
    console.log(`${"asset".padEnd(8)} ${"erc20".padStart(5)} ${"hydReg".padStart(6)} ${"cfg".padStart(4)}  dec?  ${"amountRaw".padStart(26)} ${"→human".padStart(15)} ${"intended".padStart(15)} amt?  ${"SA balance".padStart(15)} cover?`);
    console.log("-".repeat(140));
    let allOk = true;
    for (const a of ASSETS) {
      const erc20Dec = Number(await eth.readContract({ address: getAddress(a.token), abi: erc20Abi, functionName: "decimals" }));
      const saBalRaw = await eth.readContract({ address: getAddress(a.token), abi: erc20Abi, functionName: "balanceOf", args: [SA] }) as bigint;
      const reg: any = await hyd.query.AssetRegistry.Assets.getValue(a.id);
      const regDec = Number(reg?.decimals ?? reg?.value?.decimals ?? NaN);
      const cfgDec = a.decimals;

      const totalRaw = rescueRaw(a);            // full protocol-owned (sum of legs), 8dp-floored
      const intended = PROTOCOL_OWNED[a.sym];
      const human = fmt(totalRaw, erc20Dec);

      const decOk = erc20Dec === cfgDec && erc20Dec === regDec;
      const amtOk = Math.abs(human - intended) / intended < 1e-6;   // within 8dp flooring tolerance
      const coverOk = totalRaw <= saBalRaw;
      allOk &&= decOk && amtOk && coverOk;

      console.log(
        `${a.sym.padEnd(8)} ${String(erc20Dec).padStart(5)} ${String(regDec).padStart(6)} ${String(cfgDec).padStart(4)}  ${decOk ? "✅" : "❌"}   ` +
        `${totalRaw.toString().padStart(26)} ${human.toLocaleString(undefined, { maximumFractionDigits: 4 }).padStart(15)} ` +
        `${intended.toLocaleString(undefined, { maximumFractionDigits: 4 }).padStart(15)} ${amtOk ? "✅" : "❌"}   ` +
        `${fmt(saBalRaw, erc20Dec).toLocaleString(undefined, { maximumFractionDigits: 2 }).padStart(15)} ${coverOk ? "✅" : "❌"}`
      );
    }
    console.log(`\n${allOk ? "✅ decimals + amounts + coverage all consistent" : "❌ mismatch — see rows above"}`);
  } finally { await teardownForks(nets); }
}
main().then(() => process.exit(0)).catch((e) => { console.error("PROBE ERROR:", e?.stack ?? e); process.exit(1); });
