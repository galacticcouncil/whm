/**
 * One entry point per container. Ingest writes; every other entry only reads what it wrote, so
 * nothing is selected at runtime — the command names the domain, and its log says which it is.
 */
export const entryPoints = {
  "ingest/app": "src/ingest/app.ts",
  "intents/app": "src/apps/intents/app.ts",
  "basejump/app": "src/apps/basejump/app.ts",
  admin: "src/admin.ts",
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
    packages: "external",
    minify: false,
    sourcemap: true,
  };
}
