import test from "node:test";
import assert from "node:assert/strict";
import { claimGuestPopupReceipt, hasPopupReceipt, rememberPopupReceipt } from "../src/lib/popupReceipts.js";

function mockStorage(t, value) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else delete globalThis.localStorage;
  });
}

test("acknowledging one popup survives a refresh without hiding a new announcement", async t => {
  const storage = new Map();
  mockStorage(t, {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
  });
  rememberPopupReceipt(null, "release");
  const reloaded = await import("../src/lib/popupReceipts.js?reload");
  assert.equal(reloaded.hasPopupReceipt(null, "release"), true);
  assert.equal(reloaded.hasPopupReceipt(null, "next-release"), false);
  assert.equal(reloaded.claimGuestPopupReceipt("alice", "release"), true);
  assert.equal(reloaded.hasPopupReceipt("alice", "release"), true);
  assert.equal(reloaded.claimGuestPopupReceipt("bob", "release"), false);
  assert.equal(reloaded.hasPopupReceipt("bob", "release"), false);
});

test("an account click is remembered in-page when storage is inaccessible", t => {
  mockStorage(t, undefined);
  rememberPopupReceipt("alice", "maintenance");
  assert.equal(hasPopupReceipt("alice", "maintenance"), true);
  assert.equal(hasPopupReceipt(null, "maintenance"), true);
  assert.equal(hasPopupReceipt("bob", "maintenance"), false);
  assert.equal(claimGuestPopupReceipt("bob", "maintenance"), false);
});
