-- The front door lock (SwitchBot Smart Lock Ultra, through the Hub Mini).

alter table public.home_devices drop constraint home_devices_kind_check;
alter table public.home_devices add constraint home_devices_kind_check
  check (kind in ('water_heater','ac','light','tv','camera','meter','switch','lock'));
