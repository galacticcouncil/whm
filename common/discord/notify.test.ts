import assert from "node:assert/strict";
import { test } from "node:test";

import { duration, link, payload, short, text } from "./notify";

test("a line of text posts as plain content", () => {
  assert.deepEqual(payload("hello"), { content: "hello" });
});

test("an embed is headed {component} [{action}], then details, a blank line, one line per field", () => {
  const body = payload({
    component: "utxo relayer",
    action: "withdrawal stuck",
    level: "warn",
    details: "Waiting for the settlement",
    fields: [
      ["Open", "20h 53min"],
      ["To", link("t1RPps…1tkvE", "https://blockchair.com/zcash/address/t1RPpso7PVchSGWpGXEmcUHRDuTEux1tkvE")],
    ],
  });
  assert.deepEqual(body.embeds, [
    {
      title: "utxo relayer [withdrawal stuck]",
      description:
        "Waiting for the settlement\n\n**Open:** 20h 53min\n**To:** [t1RPps…1tkvE](https://blockchair.com/zcash/address/t1RPpso7PVchSGWpGXEmcUHRDuTEux1tkvE)",
      color: 0xf5a524,
    },
  ]);
});

test("details or fields alone need no blank line", () => {
  const [onlyDetails] = payload({ component: "router", action: "x", level: "ok", details: "Fine" }).embeds as { description: string }[];
  assert.equal(onlyDetails.description, "Fine");
  const [onlyFields] = payload({ component: "router", action: "x", level: "ok", fields: [["A", "1"]] }).embeds as { description: string }[];
  assert.equal(onlyFields.description, "**A:** 1");
});

test("an error tags @here, and only it may ping", () => {
  const error = payload({ component: "router", action: "stopped", level: "error" });
  assert.equal(error.content, "@here");
  assert.deepEqual(error.allowed_mentions, { parse: ["everyone"] });
  const warn = payload({ component: "router", action: "balance low", level: "warn" });
  assert.equal(warn.content, undefined);
  assert.deepEqual(warn.allowed_mentions, { parse: [] });
});

test("an embed logs as one line, links as their address", () => {
  assert.equal(
    text({
      component: "router",
      action: "waiting to swap",
      level: "warn",
      details: "Price under the floor",
      fields: [["Trade", link("0xcddd98…fb4ef", "https://scan.example/v2/trade/0xcddd")]],
    }),
    "router [waiting to swap] — Price under the floor — Trade: https://scan.example/v2/trade/0xcddd",
  );
});

test("long ids are shortened to their ends; short ones kept", () => {
  assert.equal(short("0xcddd98487cfbe7a7e95c52a9cef24da89af11130a7b887df31b804d59a6fb4ef"), "0xcddd98…fb4ef");
  assert.equal(short("t1RPpso7PVchSGWpGXEmcUHRDuTEux1tkvE", 6), "t1RPps…1tkvE");
  assert.equal(short("263"), "263");
  assert.equal(link("x"), "x");
});

test("durations read as days, hours and minutes", () => {
  assert.equal(duration(0), "0min");
  assert.equal(duration(7 * 60_000), "7min");
  assert.equal(duration(1253 * 60_000), "20h 53min");
  assert.equal(duration(25 * 3_600_000), "1d 1h");
});
