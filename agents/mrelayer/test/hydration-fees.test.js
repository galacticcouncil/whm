const assert = require("node:assert/strict");
const { BigNumber } = require("ethers");

const { getHydrationFeeOverrides } = require("../build/hydration-fees");

const BASE_FEE = BigNumber.from(7_500_000);

function provider({
  baseFee = BASE_FEE,
  priorityFee = "0x0",
  priorityFeeError = false,
} = {}) {
  return {
    getBlock: async () => ({ baseFeePerGas: baseFee }),
    getGasPrice: async () => BASE_FEE,
    send: async (method) => {
      assert.equal(method, "eth_maxPriorityFeePerGas");
      if (priorityFeeError) throw new Error("method not supported");
      return priorityFee;
    },
  };
}

async function main() {
  const zeroPriority = await getHydrationFeeOverrides(provider());
  assert.equal(zeroPriority.maxPriorityFeePerGas.toString(), "0");
  assert.equal(zeroPriority.maxFeePerGas.toString(), "15000000");

  const rpcPriority = await getHydrationFeeOverrides(
    provider({ priorityFee: "0x3e8" })
  );
  assert.equal(rpcPriority.maxPriorityFeePerGas.toString(), "1000");
  assert.equal(rpcPriority.maxFeePerGas.toString(), "15001000");

  const unsupportedPriorityRpc = await getHydrationFeeOverrides(
    provider({ priorityFeeError: true })
  );
  assert.equal(unsupportedPriorityRpc.maxPriorityFeePerGas.toString(), "0");
  assert.equal(unsupportedPriorityRpc.maxFeePerGas.toString(), "15000000");

  const legacyFees = await getHydrationFeeOverrides(
    provider({ baseFee: null })
  );
  assert.equal(legacyFees.gasPrice.toString(), BASE_FEE.toString());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
