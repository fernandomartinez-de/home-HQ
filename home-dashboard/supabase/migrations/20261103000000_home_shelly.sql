-- Shelly plugs (the espresso machine), through the Shelly Cloud Control API.

alter table public.home_devices drop constraint home_devices_provider_check;
alter table public.home_devices add constraint home_devices_provider_check
  check (provider in ('rheem','esp32','govee','tv','ring','coned','lifx','switchbot','shelly'));

-- Skips quietly until its secrets are set.
select cron.schedule('home-poll-shelly', '*/5 * * * *', $$select public.home_call_function('shelly', '{"action":"poll"}')$$);
