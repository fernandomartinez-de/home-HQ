-- Home control: devices, readings history, command queue, schedules.
-- Accessed only by the appliance edge functions (service role). RLS on, no public policies.

create table public.home_devices (
  id            text primary key,                       -- e.g. 'water_heater', 'ac', 'govee_living_room'
  kind          text not null check (kind in ('water_heater','ac','light')),
  provider      text not null check (provider in ('rheem','esp32','govee')),
  name          text not null,
  provider_ref  jsonb not null default '{}'::jsonb,     -- provider device ids/model, never secrets
  capabilities  jsonb not null default '{}'::jsonb,     -- what the device supports (modes, temp range, color)
  enabled       boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
comment on table public.home_devices is 'Home control devices (water heater, AC, lights). Read and written only by home-* edge functions.';

create table public.home_readings (
  id           bigint generated always as identity primary key,
  device_id    text not null references public.home_devices(id) on delete cascade,
  recorded_at  timestamptz not null default now(),
  source       text not null default 'poll' check (source in ('poll','device','command')),
  state        jsonb not null                           -- e.g. {"power":true,"setpoint_f":120,"mode":"heat_pump"}
);
create index home_readings_device_time on public.home_readings (device_id, recorded_at desc);
comment on table public.home_readings is 'History of device state snapshots, from scheduled polls and ESP32 pushes.';

create table public.home_commands (
  id            bigint generated always as identity primary key,
  device_id     text not null references public.home_devices(id) on delete cascade,
  command       jsonb not null,                         -- e.g. {"action":"set_temp","value":72}
  source        text not null default 'ui' check (source in ('ui','schedule','api')),
  status        text not null default 'pending' check (status in ('pending','sent','done','failed','expired')),
  result        jsonb,
  requested_at  timestamptz not null default now(),
  completed_at  timestamptz
);
create index home_commands_pending on public.home_commands (device_id, requested_at) where status = 'pending';
comment on table public.home_commands is 'Command queue and audit log. Cloud devices run immediately; the ESP32 picks up its pending commands.';

create table public.home_schedules (
  id           bigint generated always as identity primary key,
  device_id    text not null references public.home_devices(id) on delete cascade,
  name         text not null,
  days         smallint[] not null default '{0,1,2,3,4,5,6}', -- 0 = Sunday
  at_time      time not null,                                  -- local time, see time_zone
  time_zone    text not null default 'America/New_York',
  command      jsonb not null,
  enabled      boolean not null default true,
  last_run_at  timestamptz,
  created_at   timestamptz not null default now()
);
comment on table public.home_schedules is 'Recurring device actions, run by a scheduled home-scheduler function.';

create view public.home_device_latest with (security_invoker = true) as
select d.id, d.kind, d.provider, d.name, d.enabled, r.recorded_at, r.state
from public.home_devices d
left join lateral (
  select recorded_at, state from public.home_readings
  where device_id = d.id order by recorded_at desc limit 1
) r on true;
comment on view public.home_device_latest is 'Each device with its most recent reading.';

alter table public.home_devices   enable row level security;
alter table public.home_readings  enable row level security;
alter table public.home_commands  enable row level security;
alter table public.home_schedules enable row level security;
