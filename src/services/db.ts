import { createClient } from "@supabase/supabase-js";

export function getSupabase(env: Pick<Env, "SUPABASE_URL" | "SUPABASE_SERVICE_ROLE_KEY">) {
  const url = env.SUPABASE_URL.trim();
  const key = env.SUPABASE_SERVICE_ROLE_KEY.trim();

  if (!url || !key) {
    throw new Error(`Supabase service configuration missing: URL=${!!url}, SERVICE_ROLE_KEY=${!!key}`);
  }

  return createClient(url, key);
}


