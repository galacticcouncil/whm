import { config } from "dotenv";

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

let loaded = false;

export function loadEnv(path = resolve(dirname(fileURLToPath(import.meta.url)), "../.env")): void {
  if (loaded) return;
  config({ path });
  loaded = true;
}
