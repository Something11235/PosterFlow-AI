import assert from "node:assert/strict";
import { test } from "node:test";
import { passwordRecoveryRedirect } from "../src/lib/passwordRecovery.js";

test("old recovery links retain their fragment and use only the current origin", () => {
  const location = { origin: "https://posterflow.example", hash: "#access_token=synthetic&refresh_token=synthetic-refresh&type=recovery&redirect_to=https://untrusted.example" };
  assert.equal(passwordRecoveryRedirect(location), location.origin + "/api/auth/reset-password" + location.hash);
});

test("normal sign-ins and signup links do not enter password recovery", () => {
  for (const hash of ["", "#access_token=synthetic&type=signup", "#token_hash=synthetic&type=email", "#type=magiclink"]) {
    assert.equal(passwordRecoveryRedirect({ origin: "https://posterflow.example", hash }), null);
  }
});
