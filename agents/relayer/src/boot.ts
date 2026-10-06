// MUST come first: importing the Wormhole SDK (via ./chains) pulls cross-fetch, which replaces
// globalThis.fetch with node-fetch@2. `fetch.ts` captures the real one at its own module load, so
// it has to evaluate before anything that drags the SDK in — otherwise it captures the polyfill and
// `restoreNativeFetch` restores nothing, and viem dies on `response.body.getReader is not a function`.
import { restoreNativeFetch } from "./fetch";

import { registerHydration, registerRobinhood } from "./chains";
import logger from "./logger";

const BANNER = String.raw`
 ██████╗ ███████╗██╗      █████╗ ██╗   ██╗███████╗██████╗
 ██╔══██╗██╔════╝██║     ██╔══██╗╚██╗ ██╔╝██╔════╝██╔══██╗
 ██████╔╝█████╗  ██║     ███████║ ╚████╔╝ █████╗  ██████╔╝
 ██╔══██╗██╔══╝  ██║     ██╔══██║  ╚██╔╝  ██╔══╝  ██╔══██╗
 ██║  ██║███████╗███████╗██║  ██║   ██║   ███████╗██║  ██║
 ╚═╝  ╚═╝╚══════╝╚══════╝╚═╝  ╚═╝   ╚═╝   ╚══════╝╚═╝  ╚═╝
        Wormhole vaa relayer
`;

/**
 * Run one app as the process.
 *
 * Each app is its own entry point and its own container, so there is nothing to select and no way
 * to end up running the wrong one: `dist/<app>/app.js` is the app.
 *
 * @param name App name, for the startup line.
 * @param start The app's listener. Resolves once it is live; a rejection is fatal.
 */
export function boot(name: string, start: () => Promise<void>): void {
  console.log(BANNER);
  restoreNativeFetch();
  registerHydration();
  registerRobinhood();
  logger.info(`Relayer starting: ${name}`);

  start().catch((err) => {
    logger.error("fatal:", err);
    process.exit(1);
  });
}
