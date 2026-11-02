-- Routines: a list of actions that run once at a set time on chosen days (the weekday morning
-- routine: kitchen ceiling lights on, TV on with the news). Unlike schedules there is no stop.
-- The schedules function runs them on its every minute tick.

create table if not exists public.home_routines (
  id           bigint generated always as identity primary key,
  name         text not null,
  days         smallint[] not null default '{1,2,3,4,5}', -- 0 = Sunday
  at_time      time not null,                             -- local time, see time_zone
  time_zone    text not null default 'America/New_York',
  actions      jsonb not null,  -- [{"device_id": "...", "command": {...}, "wait_s": 0}], run in order
  enabled      boolean not null default true,
  last_run_at  timestamptz,
  last_result  jsonb,
  created_at   timestamptz not null default now()
);
comment on table public.home_routines is 'Timed lists of device actions, run once each time they come due (no stop).';

alter table public.home_routines enable row level security;
