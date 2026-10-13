import { forkRootKey } from "./ntt-manager/fork";

/** Prints the running fork's root key (`ed25519:…`) — what `migrate-near-ntt-*.sh fork` signs with. */
process.stdout.write(forkRootKey());
