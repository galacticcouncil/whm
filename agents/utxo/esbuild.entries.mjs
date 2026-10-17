/**
 * One entry point per app, one container per entry point. Output is `dist/<app>/app.js`, so a swarm
 * service runs `node <app>/app.js` and nothing is selected at runtime.
 */
export const entryPoints = {
  "api/app": "src/apps/api/app.ts",
  "relayer/app": "src/apps/relayer/app.ts",
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
    format: "esm",
    // Dependencies are installed in the image rather than bundled; the Dockerfile does the install.
    packages: "external",
    minify: false,
    sourcemap: true,
  };
}
