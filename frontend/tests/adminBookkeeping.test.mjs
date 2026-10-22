import test from "node:test";
import assert from "node:assert/strict";
import { amountInCents, beijingDate, formatLedgerAmount, initialStatsFrom, summarizeDays } from "../src/lib/adminBookkeeping.js";
import { toApiDate, toInputDate } from "../src/lib/announcementTime.js";
import { announcementVersion, readVersions, rememberVersions } from "../src/lib/announcementVisibility.js";

test("freeform money does not invent values for blanks, currency notes, or malformed numbers", () => {
  for (const value of ["", " ", "¥50", "50元", "1,000", "5e2", "Infinity", "12.345", "待核对", null]) assert.equal(amountInCents(value), null);
  assert.equal(amountInCents("0"), 0);
  assert.equal(amountInCents(" 128.50 "), 12850);
  assert.equal(amountInCents("-0.25"), -25);
});
test("daily sums use cents and report incomplete and freeform entries", () => {
  const result = summarizeDays([
    { new_users: 3, recharge_text: "0.10", cost_text: "0.20" },
    { new_users: 2, recharge_text: "0.20", cost_text: "待核对" },
    { new_users: 0, recharge_text: "", cost_text: "0" },
  ]);
  assert.deepEqual(result, { newUsers: 5, rechargeCents: 30, costCents: 20, rechargeDays: 2, costDays: 2, textDays: 1 });
});
test("Beijing date rolls over eight hours ahead of UTC", () => {
  assert.equal(beijingDate(0, new Date("2026-10-20T16:00:00Z")), "2026-10-21");
  assert.equal(beijingDate(-1, new Date("2026-10-20T16:00:00Z")), "2026-10-20");
});
test("admin charts start on October 11 and retain the 90-day API bound", () => {
  assert.equal(initialStatsFrom(new Date("2026-10-21T16:00:00Z")), "2026-10-11");
  assert.equal(initialStatsFrom(new Date("2027-01-10T16:00:00Z")), "2026-10-14");
});
test("cumulative SQL decimal totals display exactly without floating-point rounding", () => {
  assert.equal(formatLedgerAmount("1280.10"), "1,280.10");
  assert.equal(formatLedgerAmount("99999999999999999.99"), "99,999,999,999,999,999.99");
  assert.equal(formatLedgerAmount("-0.25"), "-0.25");
  assert.equal(formatLedgerAmount("0.00"), "0.00");
  for (const value of [null, undefined, "", "待核对", "1,000.00"]) assert.equal(formatLedgerAmount(value), "—");
});
test("announcement edit-save round trip never shifts the instant by eight hours", () => {
  const instant = "2026-10-20T16:00:00.000Z";
  assert.equal(toInputDate(instant), "2026-10-21T00:00");
  let value = instant;
  for (let i = 0; i < 5; i++) value = toApiDate(toInputDate(value));
  assert.equal(value, instant);
  assert.equal(toApiDate("2026-01-01T00:00"), "2025-12-31T16:00:00.000Z");
});
test("announcement empty and invalid dates", () => {
  assert.equal(toApiDate(""), null);
  assert.equal(toInputDate(null), "");
  for (const value of ["2026-02-30T12:00", "2026-10-21", "invalid"]) assert.throws(() => toApiDate(value));
});

test("hidden notices match only the exact announcement version", () => {
  const original = { id: "one", updated_at: "2026-10-20T16:00:00Z", title: "通知", content: "旧内容" };
  const hidden = [announcementVersion(original)];
  assert.ok(hidden.includes(announcementVersion({ ...original })));
  for (const next of [{ ...original, id: "two" }, { ...original, updated_at: "2026-10-20T17:00:00Z" }, { ...original, content: "新内容" }]) assert.ok(!hidden.includes(announcementVersion(next)));
});
test("announcement preference storage is bounded and tolerates unavailable or corrupt storage", () => {
  const storage = { getItem: () => "not json", setItem: () => { throw new Error("blocked"); } };
  assert.deepEqual(readVersions(storage, "key"), []);
  assert.deepEqual(readVersions(undefined, "key"), []);
  assert.deepEqual(rememberVersions(storage, "key", ["old"], ["new", "old"]), ["old", "new"]);
  assert.equal(rememberVersions(storage, "key", [], Array.from({ length: 150 }, (_, i) => String(i))).length, 100);
});
