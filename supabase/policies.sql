-- ============================================================================
-- Sit to Check — Row Level Security policies
-- ----------------------------------------------------------------------------
-- Run AFTER schema.sql.
--
-- Roles:
--   * anon / authenticated  -> the browser app (Supabase JS, anon key + JWT).
--     Governed entirely by the policies below.
--   * service_role           -> the ESP32 device (service key in secrets.h).
--     BYPASSES RLS, so the device can write live_data / readings_history and
--     read+update device_commands / device_config without explicit policies.
--
-- These policies reproduce the access rules from the old database.rules.json.
-- ============================================================================

alter table public.profiles         enable row level security;
alter table public.live_data        enable row level security;
alter table public.readings_history enable row level security;
alter table public.sessions         enable row level security;
alter table public.device_commands  enable row level security;
alter table public.device_config    enable row level security;
alter table public.admin_logs        enable row level security;

-- ----------------------------------------------------------------------------
-- profiles
-- ----------------------------------------------------------------------------
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.is_admin());

-- Self-insert fallback (the on_auth_user_created trigger normally handles this).
drop policy if exists profiles_insert on public.profiles;
create policy profiles_insert on public.profiles
  for insert to authenticated
  with check (id = auth.uid() and role = 'user');

-- A user may edit their own profile but may NOT promote themselves to admin.
drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid() and role = 'user');

drop policy if exists profiles_admin_all on public.profiles;
create policy profiles_admin_all on public.profiles
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ----------------------------------------------------------------------------
-- live_data: any signed-in user can read the shared chair; only admins write
-- from the browser (the device writes via service_role, bypassing RLS).
-- ----------------------------------------------------------------------------
drop policy if exists live_data_select on public.live_data;
create policy live_data_select on public.live_data
  for select to authenticated
  using (true);

drop policy if exists live_data_admin_write on public.live_data;
create policy live_data_admin_write on public.live_data
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ----------------------------------------------------------------------------
-- readings_history
-- ----------------------------------------------------------------------------
drop policy if exists readings_history_select on public.readings_history;
create policy readings_history_select on public.readings_history
  for select to authenticated
  using (owner_id = auth.uid() or public.is_admin());

drop policy if exists readings_history_admin_write on public.readings_history;
create policy readings_history_admin_write on public.readings_history
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ----------------------------------------------------------------------------
-- sessions: a user owns their sessions; admins can read everything.
-- ----------------------------------------------------------------------------
drop policy if exists sessions_select on public.sessions;
create policy sessions_select on public.sessions
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

drop policy if exists sessions_insert on public.sessions;
create policy sessions_insert on public.sessions
  for insert to authenticated
  with check (user_id = auth.uid() or public.is_admin());

drop policy if exists sessions_update on public.sessions;
create policy sessions_update on public.sessions
  for update to authenticated
  using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());

-- ----------------------------------------------------------------------------
-- device_commands: admins manage freely; a regular user may issue a START
-- (mirrors the old "Start Reading" rule). The device reads/acks via service_role.
-- ----------------------------------------------------------------------------
drop policy if exists device_commands_select on public.device_commands;
create policy device_commands_select on public.device_commands
  for select to authenticated
  using (issued_by = auth.uid() or public.is_admin());

drop policy if exists device_commands_user_start on public.device_commands;
create policy device_commands_user_start on public.device_commands
  for insert to authenticated
  with check (public.is_admin() or (action = 'START' and issued_by = auth.uid()));

drop policy if exists device_commands_user_start_update on public.device_commands;
create policy device_commands_user_start_update on public.device_commands
  for update to authenticated
  using (public.is_admin() or issued_by = auth.uid())
  with check (public.is_admin() or (action = 'START' and issued_by = auth.uid()));

-- ----------------------------------------------------------------------------
-- device_config: admin-only from the browser (device reads via service_role).
-- ----------------------------------------------------------------------------
drop policy if exists device_config_admin on public.device_config;
create policy device_config_admin on public.device_config
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ----------------------------------------------------------------------------
-- admin_logs: admin-only.
-- ----------------------------------------------------------------------------
drop policy if exists admin_logs_select on public.admin_logs;
create policy admin_logs_select on public.admin_logs
  for select to authenticated
  using (public.is_admin());

drop policy if exists admin_logs_insert on public.admin_logs;
create policy admin_logs_insert on public.admin_logs
  for insert to authenticated
  with check (public.is_admin());
