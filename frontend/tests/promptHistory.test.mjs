import test from "node:test";
import assert from "node:assert/strict";
import { cleanPromptHistory, GUEST_HISTORY_KEY, HISTORY_WINDOW_MS, readGuestPrompts, rememberGuestPrompt } from "../src/lib/promptHistory.js";

const now = Date.parse("2026-10-21T12:00:00Z");
const row = { id: "one", prompt: "中文提示词\n第二行", created_at: new Date(now).toISOString() };

test("history has only text, identity and time fields, never image/reference/key fields", () => {
  const result = cleanPromptHistory([{ ...row, image_keys: ["image.png"], reference_b64: "payload", api_key: "not-a-real-key" }], now);
  assert.deepEqual(result, [row]);
});
test("seven-day cutoff excludes expired, malformed, future and duplicate records", () => {
  const entries = [row, row, { ...row, id: "old", created_at: new Date(now-HISTORY_WINDOW_MS).toISOString() }, { ...row, id: "future", created_at: new Date(now+1).toISOString() }, { ...row, id: "invalid", created_at: "invalid" }, { ...row, id: "empty", prompt: "  " }];
  assert.deepEqual(cleanPromptHistory(entries, now), [row]);
});
test("guest records persist and expired text is physically pruned on access", () => {
  const values = new Map();
  globalThis.localStorage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  rememberGuestPrompt(row.prompt, row.id, now);
  assert.deepEqual(readGuestPrompts(now), [row]);
  assert.deepEqual(readGuestPrompts(now+HISTORY_WINDOW_MS), []);
  assert.equal(values.get(GUEST_HISTORY_KEY), "[]");
});
test("quota failure preserves fresh in-memory text rather than rereading stale persisted data", () => {
  globalThis.localStorage = { getItem: () => JSON.stringify([{ ...row, id: "persisted" }]), setItem: () => { throw new Error("quota"); } };
  assert.doesNotThrow(() => rememberGuestPrompt("本机提示词", "blocked", now));
  assert.equal(readGuestPrompts(now).find(item => item.id === "blocked").prompt, "本机提示词");
  delete globalThis.localStorage;
});
