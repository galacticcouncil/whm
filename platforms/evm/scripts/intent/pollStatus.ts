import "dotenv/config";

import { OneClickService } from "@defuse-protocol/one-click-sdk-typescript";

import { args } from "@whm/common";

const { requiredArg, optionalArg } = args;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const depositAddress = requiredArg("--deposit-address");
  const intervalSec = Number(optionalArg("--interval-sec") ?? 5);
  const totalSec = Number(optionalArg("--total-sec") ?? 300);

  const start = Date.now();
  let lastSerialised = "";
  while (Date.now() - start < totalSec * 1000) {
    const elapsed = Math.round((Date.now() - start) / 1000);
    const status = await OneClickService.getExecutionStatus(depositAddress);
    const serialised = JSON.stringify(status);
    if (serialised !== lastSerialised) {
      console.log(`\n[+${elapsed}s] status changed:`);
      console.log(JSON.stringify(status, null, 2));
      lastSerialised = serialised;
    } else {
      process.stdout.write(`[+${elapsed}s] ${status.status}\r`);
    }
    await sleep(intervalSec * 1000);
  }
  console.log(`\n\nTimed out after ${totalSec}s.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
