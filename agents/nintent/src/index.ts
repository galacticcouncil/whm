import api from "./api";
import log from "./logger";

import { client } from "./clients";
import { source } from "./config";
import { start as startEndpoints } from "./endpoints";
import { IntentWatcher } from "./watcher";

const BANNER = String.raw`
 ███╗   ██╗██╗███╗   ██╗████████╗███████╗███╗   ██╗████████╗
 ████╗  ██║██║████╗  ██║╚══██╔══╝██╔════╝████╗  ██║╚══██╔══╝
 ██╔██╗ ██║██║██╔██╗ ██║   ██║   █████╗  ██╔██╗ ██║   ██║
 ██║╚██╗██║██║██║╚██╗██║   ██║   ██╔══╝  ██║╚██╗██║   ██║
 ██║ ╚████║██║██║ ╚████║   ██║   ███████╗██║ ╚████║   ██║
 ╚═╝  ╚═══╝╚═╝╚═╝  ╚═══╝   ╚═╝   ╚══════╝╚═╝  ╚═══╝   ╚═╝
        near intent agent & api
`;

async function main(): Promise<void> {
  console.log(BANNER);
  log.info("nintent starting...");
  log.info(`  receiver: ${source.name} @ ${source.receiver}`);

  const watcher = new IntentWatcher({ name: source.name, receiver: source.receiver }, client);

  api(watcher);
  await startEndpoints();
  watcher.start();

  log.info("nintent ready.");
}

main().catch((err) => {
  log.error("fatal:", err);
  process.exit(1);
});
