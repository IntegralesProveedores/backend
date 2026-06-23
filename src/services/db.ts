import { createClient } from "@supabase/supabase-js";

export function getSupabase(env: any) {
  const url = (env.SUPABASE_URL || "").trim();
  const key = (env.SUPABASE_ANON_KEY || "").trim();

  if (!url || !key) {
    throw new Error(`Supabase configuration missing: URL=${!!url}, KEY=${!!key}`);
  }

  return createClient(url, key);
}


