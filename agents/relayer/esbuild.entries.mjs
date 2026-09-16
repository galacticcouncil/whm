/**
 * One entry point per app, one container per entry point. Output is `dist/<app>/app.js`, so a swarm
 * service runs `node <app>/app.js` and nothing is selected at runtime.
 */
export const entryPoints = {
  "ntt/app": "src/apps/ntt/app.ts",
  "oracle/app": "src/apps/oracle/app.ts",
  "intent/app": "src/apps/intent/app.ts",
  "basejump/app": "src/apps/basejump/app.ts",
};

/**
 * Build options shared by the dev and dist builds.
 *
 * @param config The root esbuild config.
 * @returns Options with `outfile` swapped for a multi-entry `outdir`.
 */
export function multiEntry(config) {
  const { outfile: _outfile, entryPoints: _entryPoints, ...base } = config;
  return {
    ...base,
    entryPoints,
    outdir: "dist",
    bundle: true,
    /**
     * Dependencies are NOT bundled, and this is load-bearing rather than a preference.
     *
     * relayer-engine pulls @certusone/wormhole-sdk, which pulls the Injective/Cosmos SDKs. Those
     * have circular CJS requires and re-exported TS enums that esbuild cannot flatten correctly: the
     * bundle builds fine and then dies at load with `Cannot read properties of undefined (reading
     * 'Mainnet')` inside @injectivelabs/networks. Leaving packages external sidesteps the whole
     * class of problem — the Dockerfile installs them instead.
     */
    packages: "external",
    minify: false,
    sourcemap: true,
  };
}
