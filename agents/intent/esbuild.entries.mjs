import { readFileSync } from "node:fs";

/** What the image installs — everything else is bundled. */
const { dependencies } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

/**
 * One entry point per app, one container per entry point. Output is `dist/<app>/app.js`, so a swarm
 * service runs `node <app>/app.js` and nothing is selected at runtime.
 */
export const entryPoints = {
  "relayer/app": "src/apps/relayer/app.ts",
  "quoter/app": "src/apps/quoter/app.ts",
  "router/app": "src/apps/router/app.ts",
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
    // Workspace packages (`@whm/common`) are not on npm, so they are bundled.
    external: Object.keys(dependencies),
    minify: false,
    sourcemap: true,
  };
}
