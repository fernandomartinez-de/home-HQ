-- LIFX lights and SwitchBot switches (a Bot on the towel warmer, plugs, relays).

alter table public.home_devices drop constraint home_devices_kind_check;
alter table public.home_devices add constraint home_devices_kind_check
  check (kind in ('water_heater','ac','light','tv','camera','meter','switch'));

alter table public.home_devices drop constraint home_devices_provider_check;
alter table public.home_devices add constraint home_devices_provider_check
  check (provider in ('rheem','esp32','govee','tv','ring','coned','lifx','switchbot'));

-- Both polls skip quietly until their secrets are set.
select cron.schedule('home-poll-lifx', '*/5 * * * *', $$select public.home_call_function('lifx', '{"action":"poll"}')$$);
select cron.schedule('home-poll-switchbot', '*/5 * * * *', $$select public.home_call_function('switchbot', '{"action":"poll"}')$$);
