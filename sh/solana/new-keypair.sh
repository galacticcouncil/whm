#!/usr/bin/env bash
#
# Generate a new Solana wallet keypair for local development/testing.
#
# Usage: ./sh/new-keypair.sh [name]
#   name  — output file name (default: "test")
#           Keypair is written to ~/.config/solana/<name>.json
#
# Examples:
#   ./sh/new-keypair.sh           -> ~/.config/solana/test.json
#   ./sh/new-keypair.sh deployer  -> ~/.config/solana/deployer.json

NAME="${1:-test}"
solana-keygen new --outfile ~/.config/solana/"${NAME}".json -f
