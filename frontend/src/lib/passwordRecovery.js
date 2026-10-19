// Old reset emails redirect to the homepage with an implicit recovery session.
// Forward the fragment before the SDK can consume it or any UI requests run.
export function passwordRecoveryRedirect(location) {
  const params = new URLSearchParams((location.hash || "").slice(1));
  if (params.get("type") !== "recovery") return null;
  return `${location.origin}/api/auth/reset-password${location.hash}`;
}
