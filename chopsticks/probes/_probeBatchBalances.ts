/** Dispatch the moxit batch as Root, verify SA ERC20 balance drops by exactly amountRaw per asset. */
import { readFileSync } from "node:fs";
import { createPublicClient, http, erc20Abi, getAddress, type Hex, type PublicClient } from "viem";
import { Binary } from "polkadot-api";
import { configs } from "../lib/configs";
import { spawnForks, teardownForks, type Network } from "../lib/network";
import { acc } from "@galacticcouncil/common";

const SA = getAddress(acc.getSovereignAccounts(2034).moonbeam as Hex);
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function evAt(net:Network,at:string,t=12):Promise<any[]>{let e;for(let i=0;i<t;i++){try{return await net.client.getUnsafeApi().query.System.Events.getValue({at});}catch(x){e=x;await sleep(300);}}throw e;}

async function main(){
  const d=JSON.parse(readFileSync("probes/moxit-proposal.json","utf8"));
  const nets=await spawnForks([configs.hydration,configs.moonbeam]);
  const {hydration,moonbeam}=nets;
  try{
    await moonbeam.setStorage({System:{Account:[[[SA],{providers:1,data:{free:5000n*10n**18n}}]]}});
    const eth=createPublicClient({transport:http(`http://127.0.0.1:${configs.moonbeam.port}`)}) as PublicClient;
    const bal=(tok:string)=>eth.readContract({address:getAddress(tok),abi:erc20Abi,functionName:"balanceOf",args:[SA]}) as Promise<bigint>;
    const before:Record<string,bigint>={};
    for(const a of d.assets) before[a.sym]=await bal(a.token);

    // dispatch batch as Root
    const bytes=Binary.fromHex(d.innerBatchAll as Hex); const len=bytes.length;
    const hash=(await hydration.chain.head.registry).hash(bytes).toHex() as Hex;
    const when=hydration.chain.head.number+1;
    await hydration.setStorage({
      Preimage:{PreimageFor:[[[[hash,len]],Array.from(bytes)]]},
      Scheduler:{Agenda:[[[when],[{maybeId:null,priority:0,call:{Lookup:{hash,len}},maybePeriodic:null,origin:{system:"Root"}}]]]},
    });
    await hydration.chain.newBlock();
    await hydration.chain.newBlock(); // flush HRMP
    for(let i=0;i<6;i++){ await moonbeam.chain.newBlock(); }
    await sleep(500);

    console.log("\n── SA deduction per asset (expect delta == -amountRaw) ──");
    let allok=true;
    for(const a of d.assets){
      const after=await bal(a.token);
      const delta=after-before[a.sym];
      const exp=-BigInt(a.amountRaw);
      const ok=delta===exp;
      if(!ok) allok=false;
      console.log(`  ${a.sym.padEnd(8)} before ${before[a.sym]} after ${after}  Δ ${delta}  expect ${exp}  ${ok?"✅":"❌"}`);
    }
    console.log(`\n${allok?"✅ all 11 SA deductions exact":"❌ mismatch"}`);
  } finally { await teardownForks(nets); }
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)});
