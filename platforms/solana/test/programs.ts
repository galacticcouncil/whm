import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";

import { Sender } from "../target/types/sender";

describe("sender", () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.env();
  console.log("RPC:", provider.connection.rpcEndpoint);
  anchor.setProvider(provider);

  const program = anchor.workspace.sender as Program<Sender>;

  it("Is initialized!", async () => {
    // Add your test here.
    const tx = await program.methods.initialize().rpc();
    console.log("Your transaction signature", tx);
  });
});
