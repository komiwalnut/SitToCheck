-- ============================================================================
-- Sit to Check — seed data
-- ----------------------------------------------------------------------------
-- Run AFTER schema.sql and policies.sql. Safe to re-run (idempotent upserts).
-- ============================================================================

-- Default pressure calibration for CHAIR_01
-- (replaces database-calibration-default.json from the Firebase project).
insert into public.device_config (device_id, pressure_zero_adc, pressure_mmhg_per_adc, bp_target_adc, bp_max_adc, updated_by)
values ('CHAIR_01', 410, 0.22, 1700, 2500, null)
on conflict (device_id) do nothing;

-- Initialise an empty live_data row so the dashboard has something to subscribe
-- to before the device's first upload.
insert into public.live_data (device_id, sensor_valid, alert)
values ('CHAIR_01', false, 'NO_FINGER')
on conflict (device_id) do nothing;

-- ----------------------------------------------------------------------------
-- Promote an admin AFTER you have signed that account up through the web app:
--
--   update public.profiles set role = 'admin' where email = 'you@example.com';
--
-- ----------------------------------------------------------------------------
