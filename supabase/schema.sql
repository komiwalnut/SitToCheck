-- ============================================================================
-- Sit to Check — Supabase (PostgreSQL) schema
-- ----------------------------------------------------------------------------
-- Run this in the Supabase SQL editor (or `supabase db push`) on a fresh
-- project. It replaces the old Firebase Realtime Database tree:
--
--   Firebase RTDB                          ->  Postgres table
--   ---------------------------------------    ----------------------------
--   Users/{uid}/profile                    ->  public.profiles
--   Admins/{uid}                           ->  public.profiles.role = 'admin'
--   Users/{owner}/Live_Data                ->  public.live_data        (1 row/device)
--   Users/{owner}/History                  ->  public.readings_history (append-only)
--   Users/{uid}/Sessions                   ->  public.sessions
--   Users/{owner}/Commands                 ->  public.device_commands  (1 row/device)
--   DEVICE_CONFIG/{device}/calibration     ->  public.device_config
--   Admin_Logs                             ->  public.admin_logs
--
-- Apply order:  schema.sql  ->  policies.sql  ->  seed.sql
-- ============================================================================

-- ----------------------------------------------------------------------------
-- profiles: one row per auth user (mirrors Firebase Users/{uid}/profile).
-- The id is the Supabase auth user id. role replaces the separate Admins node.
-- ----------------------------------------------------------------------------
create table if not exists public.profiles (
  id                  uuid primary key references auth.users (id) on delete cascade,
  first_name          text,
  last_name           text,
  age                 int check (age is null or (age >= 1 and age <= 120)),
  email               text,
  role                text not null default 'user' check (role in ('user', 'admin')),
  consent_accepted    boolean not null default false,
  consent_accepted_at timestamptz,
  created_at          timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- live_data: latest reading per device. Upserted in place by the device
-- (mirrors the single Live_Data node). Realtime clients subscribe to changes.
-- ----------------------------------------------------------------------------
create table if not exists public.live_data (
  device_id        text primary key,
  owner_id         uuid references auth.users (id) on delete set null,
  heart_rate       int,
  spo2             int,
  temperature      numeric(5, 2),
  bp_systolic      int,
  bp_diastolic     int,
  sensor_valid     boolean not null default false,
  alert            text,
  wifi_ssid        text,
  wifi_rssi        int,
  battery_percent  numeric(5, 2),
  battery_voltage  numeric(5, 2),
  device_timestamp bigint,          -- epoch seconds reported by the device
  updated_at       timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- readings_history: append-only log uploaded by the device every 60s
-- (mirrors Users/{owner}/History).
-- ----------------------------------------------------------------------------
create table if not exists public.readings_history (
  id               bigint generated always as identity primary key,
  device_id        text not null,
  owner_id         uuid references auth.users (id) on delete set null,
  heart_rate       int,
  spo2             int,
  temperature      numeric(5, 2),
  bp_systolic      int,
  bp_diastolic     int,
  sensor_valid     boolean not null default false,
  alert            text,
  device_timestamp bigint,
  created_at       timestamptz not null default now()
);

create index if not exists readings_history_device_created_idx
  on public.readings_history (device_id, created_at desc);

-- ----------------------------------------------------------------------------
-- sessions: per-user reading sessions started from the dashboard
-- (mirrors Users/{uid}/Sessions).
-- ----------------------------------------------------------------------------
create table if not exists public.sessions (
  id            bigint generated always as identity primary key,
  user_id       uuid not null references auth.users (id) on delete cascade,
  device_id     text,
  started_at    timestamptz not null,
  ended_at      timestamptz,
  reason        text,
  heart_rate    int,
  spo2          int,
  temperature   numeric(5, 2),
  bp_systolic   int,
  bp_diastolic  int,
  sensor_valid  boolean not null default false,
  risk_level    text,
  risk_class    text,
  device_online boolean not null default false,
  created_at    timestamptz not null default now()
);

create index if not exists sessions_user_started_idx
  on public.sessions (user_id, started_at desc);

-- ----------------------------------------------------------------------------
-- device_commands: latest command targeted at a device. Upserted in place
-- (mirrors Users/{owner}/Commands). The device polls it and sets status='done'.
-- ----------------------------------------------------------------------------
create table if not exists public.device_commands (
  device_id  text primary key,
  action     text not null check (action in ('START', 'STOP', 'RESET', 'switch_wifi')),
  issued_by  uuid references auth.users (id) on delete set null,
  status     text not null default 'pending' check (status in ('pending', 'done', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- device_config: per-device pressure calibration
-- (mirrors DEVICE_CONFIG/{device}/calibration).
-- ----------------------------------------------------------------------------
create table if not exists public.device_config (
  device_id            text primary key,
  pressure_zero_adc    int     not null default 410,
  pressure_mmhg_per_adc numeric not null default 0.22,
  bp_target_adc        int     not null default 1700,
  bp_max_adc           int     not null default 2500,
  updated_at           timestamptz not null default now(),
  updated_by           uuid references auth.users (id) on delete set null
);

-- ----------------------------------------------------------------------------
-- admin_logs: audit trail of admin/device actions (mirrors Admin_Logs).
-- ----------------------------------------------------------------------------
create table if not exists public.admin_logs (
  id         bigint generated always as identity primary key,
  action     text,
  user_id    uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists admin_logs_created_idx
  on public.admin_logs (created_at desc);

-- ----------------------------------------------------------------------------
-- Helper: is_admin() — used by RLS policies. SECURITY DEFINER so it can read
-- profiles without tripping the very policies that call it (no recursion).
-- ----------------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

-- ----------------------------------------------------------------------------
-- Trigger: auto-create a profile row when a new auth user signs up. The web
-- signup form passes first_name/last_name/age/consent via auth metadata.
-- ----------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, first_name, last_name, age, email, role, consent_accepted, consent_accepted_at)
  values (
    new.id,
    new.raw_user_meta_data ->> 'first_name',
    new.raw_user_meta_data ->> 'last_name',
    nullif(new.raw_user_meta_data ->> 'age', '')::int,
    new.email,
    'user',
    coalesce((new.raw_user_meta_data ->> 'consent_accepted')::boolean, false),
    case when (new.raw_user_meta_data ->> 'consent_accepted')::boolean then now() else null end
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ----------------------------------------------------------------------------
-- Trigger: keep updated_at fresh on mutable single-row tables.
-- ----------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists live_data_touch on public.live_data;
create trigger live_data_touch
  before update on public.live_data
  for each row execute function public.touch_updated_at();

drop trigger if exists device_commands_touch on public.device_commands;
create trigger device_commands_touch
  before update on public.device_commands
  for each row execute function public.touch_updated_at();

-- ----------------------------------------------------------------------------
-- Realtime: publish live_data (and device_commands) so the dashboard and the
-- device get push updates. Wrapped so re-running the script is safe.
-- ----------------------------------------------------------------------------
do $$
begin
  begin
    alter publication supabase_realtime add table public.live_data;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.device_commands;
  exception when duplicate_object then null;
  end;
end;
$$;
