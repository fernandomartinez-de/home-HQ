-- The Fire TV as a home device. The TV app (tv-dashboard/android, HomeService) polls the tv
-- function for pending commands and reports what's on screen; the dashboard queues commands.

alter table public.home_devices drop constraint home_devices_kind_check;
alter table public.home_devices add constraint home_devices_kind_check
  check (kind in ('water_heater','ac','light','tv'));

alter table public.home_devices drop constraint home_devices_provider_check;
alter table public.home_devices add constraint home_devices_provider_check
  check (provider in ('rheem','esp32','govee','tv'));

insert into public.home_devices (id, kind, provider, name, capabilities)
values ('tv', 'tv', 'tv', 'Living Room TV', jsonb_build_object(
  'apps', jsonb_build_array(
    jsonb_build_object('pkg', 'com.netflix.ninja', 'name', 'Netflix'),
    jsonb_build_object('pkg', 'com.amazon.firetv.youtube', 'name', 'YouTube'),
    jsonb_build_object('pkg', 'com.amazon.firebat', 'name', 'Prime Video'),
    jsonb_build_object('pkg', 'com.hbo.hbonow', 'name', 'HBO Max'),
    jsonb_build_object('pkg', 'com.disney.disneyplus', 'name', 'Disney+'),
    jsonb_build_object('pkg', 'com.spotify.tv.android', 'name', 'Spotify')
  ),
  'actions', jsonb_build_array('launch', 'home', 'back', 'volume', 'sleep')
))
on conflict (id) do nothing;
