-- Rheem style weekly schedules: one row per day and slot, plus a per device switch.
alter table public.home_schedules add column if not exists slot text;
alter table public.home_devices add column if not exists schedule_enabled boolean not null default false;
comment on column public.home_schedules.slot is 'Slot name within the day, e.g. Morning, Day, Evening, Night.';
comment on column public.home_devices.schedule_enabled is 'Whether Home HQ runs this device''s schedule.';
create index if not exists home_schedules_device on public.home_schedules (device_id);

-- Run due slots every minute.
select cron.schedule('home-schedules-tick', '* * * * *', $$select public.home_call_function('schedules', '{"action":"tick"}')$$);
