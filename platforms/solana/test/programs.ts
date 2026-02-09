import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";

import { expect } from "chai";

const { PublicKey } = anchor.web3;

import { Sender } from "../target/types/sender";

describe("sender", () => {
  const provider = anchor.AnchorProvider.env();
  console.log("RPC:", provider.connection.rpcEndpoint);
  anchor.setProvider(provider);

  const program = anchor.workspace.sender as Program<Sender>;

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);

  it("initializes config", async () => {
    const tx = await program.methods
      .initialize()
      .accounts({
        owner: provider.wallet.publicKey,
      })
      .rpc();

    console.log("initialize tx:", tx);

    const config = await program.account.config.fetch(configPda);
    expect(config.owner.toBase58()).to.equal(provider.wallet.publicKey.toBase58());
  });
});
