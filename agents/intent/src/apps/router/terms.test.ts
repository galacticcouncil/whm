import assert from "node:assert/strict";
import { test } from "node:test";

import { decodeTerms } from "./terms";

/** `GOLDEN_TERMS` from `contracts/test/intents-v2/IntentCodecTest.sol`. */
const GOLDEN = Buffer.from(
  "013333333333333333333333333333333333333333111111111111111111111111111111111111111111111111111111111111111100640200000000000000000000000008f0d180000000000000000000000000000f4240000000006b49d200002222222222222222222222222222222222222222146e65703134313a7a65632e6f6d66742e6e6561722374314b50565352676e46485042574d4a4c433774614a696f4e366d3551366a56426d61",
  "hex",
);

test("the golden terms decode as the codec encodes them", () => {
  assert.deepEqual(decodeTerms(GOLDEN), {
    maxSlippageBps: 100n,
    maxFillMultiplier: 2n,
    minOutPerIn: 150_000_000n,
    minDelivery: 1_000_000n,
    deadlineMs: 1_800_000_000_000,
    recipientKind: 0,
    destinationAsset: "nep141:zec.omft.near",
    recipient: "t1KPVSRgnFHPBWMJLC7taJioN6m5Q6jVBma",
  });
});
