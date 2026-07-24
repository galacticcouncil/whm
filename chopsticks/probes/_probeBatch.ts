/** Dispatch the assembled utility.batchAll([11 sends]) as Root — count all 11 Wormhole messages. */
import { readFileSync } from "node:fs";
import { encodeEventTopics, getAddress, type Abi, type Hex } from "viem";
import { Binary } from "polkadot-api";
import { configs } from "../lib/configs";
import { checkIfXcmSent, findEvent, type EventRecord } from "../lib/events";
import { spawnForks, teardownForks, type Network } from "../lib/network";
import { acc } from "@galacticcouncil/common";

const CORE = getAddress("0xC8e2b0cD52Cf01b0Ce87d389Daa3d414d4cE29f3");
const SA = acc.getSovereignAccounts(2034).moonbeam as Hex;
const ABI = [{ type:"event", name:"LogMessagePublished", inputs:[{name:"sender",type:"address",indexed:true},{name:"sequence",type:"uint64"},{name:"nonce",type:"uint32"},{name:"payload",type:"bytes"},{name:"consistencyLevel",type:"uint8"}]}] as const satisfies Abi;
const TOPIC = encodeEventTopics({ abi: ABI, eventName: "LogMessagePublished" })[0]!.toLowerCase();
const hx = (x:any):string => x==null?"":typeof x==="string"?x.toLowerCase():typeof x?.asHex==="function"?x.asHex().toLowerCase():x instanceof Uint8Array?"0x"+Array.from(x,(b:number)=>b.toString(16).padStart(2,"0")).join(""):String(x).toLowerCase();
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function evAt(net:Network,at:string,t=12):Promise<EventRecord[]>{let e;for(let i=0;i<t;i++){try{return await net.client.getUnsafeApi().query.System.Events.getValue({at}) as EventRecord[];}catch(x){e=x;await sleep(300);}}throw e;}
function coreLogs(events:EventRecord[]){let n=0;for(const{event}of events){const ev=event as any;if(ev.type!=="EVM"||ev.value?.type!=="Log")continue;const l=ev.value.value?.log;if(l&&hx(l.address)===CORE.toLowerCase()&&hx((l.topics??[])[0])===TOPIC)n++;}return n;}

async function main(){
  const { innerBatchAll } = JSON.parse(readFileSync("probes/moxit-proposal.json","utf8"));
  const nets = await spawnForks([configs.hydration, configs.moonbeam]);
  const { hydration, moonbeam } = nets;
  try{
    await moonbeam.setStorage({ System:{ Account:[[[SA],{providers:1,data:{free:5000n*10n**18n}}]] }});
    const bytes = Binary.fromHex(innerBatchAll); const len=bytes.length;
    const hash=(await hydration.chain.head.registry).hash(bytes).toHex() as Hex;
    const when = hydration.chain.head.number+1;
    await hydration.setStorage({
      Preimage:{ PreimageFor:[[[[hash,len]],Array.from(bytes)]] },
      Scheduler:{ Agenda:[[[when],[{maybeId:null,priority:0,call:{Lookup:{hash,len}},maybePeriodic:null,origin:{system:"Root"}}]]] },
    });
    const b = await hydration.chain.newBlock();
    const hydEv = await evAt(hydration, b.hash);
    console.log("Scheduler.Dispatched:", !!findEvent(hydEv,"Scheduler","Dispatched"), "| PolkadotXcm.Sent:", checkIfXcmSent(hydEv));
    await hydration.chain.newBlock();
    let total=0;
    for(let i=0;i<6;i++){ const blk=await moonbeam.chain.newBlock(); const n=coreLogs(await evAt(moonbeam,blk.hash)); total+=n; console.log(`  moonbeam #${blk.number}: ${n} LogMessagePublished`); }
    console.log(`\n${total}/11 Wormhole messages from one batched Root proposal ${total===11?"✅":"❌"}`);
  } finally { await teardownForks(nets); }
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)});
