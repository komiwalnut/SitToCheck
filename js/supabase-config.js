// ============================================================================
// Supabase client configuration
// ----------------------------------------------------------------------------
// Replace the two placeholder values below with your own project's credentials:
//   Supabase Dashboard > Project Settings > API
//     * Project URL   -> SUPABASE_URL
//     * anon public   -> SUPABASE_ANON_KEY   (safe to expose in the browser;
//                        access is still enforced by Row Level Security)
//
// Do NOT put the service_role key here — that key bypasses RLS and must never
// ship in browser code. It belongs only in the ESP32 firmware's secrets.h.
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

export const SUPABASE_URL      = 'https://YOUR-PROJECT-REF.supabase.co';
export const SUPABASE_ANON_KEY = 'YOUR-SUPABASE-ANON-KEY';

// The device this dashboard monitors. Matches DEVICE_ID in the ESP32 firmware.
export const DEVICE_ID = 'CHAIR_01';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
});
