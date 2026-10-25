alter table public.home_devices add column if not exists room text;
comment on column public.home_devices.room is 'Room shown on the dashboard. Set by hand; appliance polls never overwrite it.';

create or replace view public.home_device_latest with (security_invoker = true) as
select d.id, d.kind, d.provider, d.name, d.enabled, r.recorded_at, r.state, d.room
from public.home_devices d
left join lateral (
  select recorded_at, state from public.home_readings
  where device_id = d.id order by recorded_at desc limit 1
) r on true;

-- Room assignments are personal data and are set directly in the database, for example:
-- update public.home_devices set room = 'Kitchen' where name ilike 'kitchen%';
