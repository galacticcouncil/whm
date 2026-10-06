/**
 * One entry point per app, one container per entry point. Output is `dist/<app>/app.js`, so a swarm
 * service runs `node <app>/app.js` and nothing is selected at runtime.
 */
export const entryPoints = {
  "oracle-solana/app": "src/apps/oracle-solana/app.ts",
  "oracle-ethereum/app": "src/apps/oracle-ethereum/app.ts",
  "oracle-robinhood/app": "src/apps/oracle-robinhood/app.ts",
};

/**
 * Build options shared by the dev and dist builds.
 *
 * @param config The root esbuild config.
 * @returns Options with `outfile` swapped for a multi-entry `outdir`.
 */
export function multiEntry(config) {
  const { outfile: _outfile, entryPoints: _entryPoints, ...base } = config;
  return { ...base, entryPoints, outdir: "dist", bundle: true };
}
