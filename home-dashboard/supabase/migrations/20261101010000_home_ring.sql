-- Ring cameras: the ring function (ring/functions/ring) registers each camera as kind 'camera'.

alter table public.home_devices drop constraint home_devices_kind_check;
alter table public.home_devices add constraint home_devices_kind_check
  check (kind in ('water_heater','ac','light','tv','camera'));

alter table public.home_devices drop constraint home_devices_provider_check;
alter table public.home_devices add constraint home_devices_provider_check
  check (provider in ('rheem','esp32','govee','tv','ring'));

-- Battery, mode and recent events every 5 minutes (does nothing until Ring is connected).
select cron.schedule('home-poll-ring', '*/5 * * * *', $$select public.home_call_function('ring', '{"action":"poll"}')$$);
