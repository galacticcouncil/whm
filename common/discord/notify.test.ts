import assert from "node:assert/strict";
import { test } from "node:test";

import { duration, payload, text } from "./notify";

const NOW = Date.UTC(2026, 10, 27, 12, 18);

test("a line of text posts as plain content, pinging no one new", () => {
  assert.deepEqual(payload("hello"), { content: "hello" });
});

test("an error tags @here, and only it may ping", () => {
  const body = payload({ title: "Stopped", level: "error" }, NOW);
  assert.equal(body.content, "@here");
  assert.deepEqual(body.allowed_mentions, { parse: ["everyone"] });
  const warn = payload({ title: "Low", level: "warn" }, NOW);
  assert.equal(warn.content, undefined);
  assert.deepEqual(warn.allowed_mentions, { parse: [] });
});

test("an embed carries colour, linked title, fields, source and time", () => {
  const body = payload(
    {
      title: "Withdrawal stuck",
      level: "warn",
      source: "utxo relayer",
      url: "https://bot.example/x",
      fields: [
        ["Open", "20 h 53 min"],
        ["To", "`t1RPpso7PVchSGWpGXEmcUHRDuTEux1tkvE`"],
        ["Empty", ""],
      ],
    },
    NOW,
  );
  const [embed] = body.embeds as Record<string, unknown>[];
  assert.equal(embed.color, 0xf5a524);
  assert.equal(embed.url, "https://bot.example/x");
  assert.deepEqual(embed.footer, { text: "utxo relayer" });
  assert.equal(embed.timestamp, "2026-11-27T12:18:00.000Z");
  assert.deepEqual(embed.fields, [
    { name: "Open", value: "20 h 53 min", inline: true },
    { name: "To", value: "`t1RPpso7PVchSGWpGXEmcUHRDuTEux1tkvE`", inline: false },
    { name: "Empty", value: "—", inline: true },
  ]);
});

test("an embed logs as one line, without backticks", () => {
  assert.equal(
    text({ title: "Balance low", level: "warn", source: "router", fields: [["Account", "`relayer.near`"]] }),
    "router: Balance low — Account: relayer.near",
  );
});

test("durations read as days, hours and minutes", () => {
  assert.equal(duration(0), "0 min");
  assert.equal(duration(7 * 60_000), "7 min");
  assert.equal(duration(1253 * 60_000), "20 h 53 min");
  assert.equal(duration(25 * 3_600_000), "1 d 1 h");
});
