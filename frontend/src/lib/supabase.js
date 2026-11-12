import { createClient } from "@supabase/supabase-js";
import { passwordRecoveryRedirect } from "./passwordRecovery";
import { createAuthProxyFetch } from "./authTransport";

const recoveryRedirect = typeof window !== "undefined" ? passwordRecoveryRedirect(window.location) : null;
if (recoveryRedirect) window.location.replace(recoveryRedirect);

const url = import.meta.env.VITE_SUPABASE_URL?.trim();
const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY || import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || "").trim();

export const supabaseConfigured = Boolean(url && anonKey);

export const supabase = supabaseConfigured
  ? createClient(url, anonKey, {
      global: { fetch: createAuthProxyFetch(url) },
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: !recoveryRedirect,
      },
    })
  : null;
