import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const PACKAGE = "package.json";
const ENCODING = "utf-8";

export function getPackageJson(metaUrl) {
  const fileName = fileURLToPath(metaUrl);
  const dirName = dirname(fileName);
  const absPath = resolve(dirName, PACKAGE);
  const file = readFileSync(absPath, ENCODING);
  return JSON.parse(file);
}

export const common = {
  entryPoints: ["src/index.ts"],
  treeShaking: true,
  minify: true,
  metafile: true,
  logLevel: "info",
};

export const config = {
  ...common,
  outfile: "dist/index.js",
  format: "cjs",
  platform: "node",
  logLevel: "info",
};
