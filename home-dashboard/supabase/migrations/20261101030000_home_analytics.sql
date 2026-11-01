-- History & Analytics: one call returns everything the History tab draws.
--
--   energy   daily kWh (and cost when known) from Con Edison, up to about 13 months
--   lights   hours each room had at least one light on, per day
--   heater   per day: average and lowest tank level, hours heating (and with the element), hours off
--   tv       hours with the screen on per day
--   camera   distinct Ring events (motion, person, doorbell) in the window
--   activity commands sent (from the dashboard or a schedule), newest first
--
-- Time spent in a state is the gap to the device's next reading, capped at 15 minutes so a polling
-- outage doesn't count as hours on. Days are calendar days in New York.

create or replace function public.home_analytics(p_days int default 14) returns jsonb
language sql stable security definer set search_path = '' as $$
with
win as (select now() - make_interval(days => greatest(1, least(coalesce(p_days, 14), 90))) as since),
r as (
  select d.kind, coalesce(nullif(d.room, ''), 'Other') as room, r.recorded_at, r.state,
         (r.recorded_at at time zone 'America/New_York')::date as day,
         extract(epoch from least(coalesce(lead(r.recorded_at) over w, now()) - r.recorded_at, interval '15 minutes')) / 3600.0 as hours
  from public.home_readings r
  join public.home_devices d on d.id = r.device_id
  where d.kind in ('light', 'water_heater', 'tv')
    and r.recorded_at >= (select since from win) - interval '15 minutes'
  window w as (partition by r.device_id order by r.recorded_at)
),
rw as (select * from r where recorded_at >= (select since from win)),
-- A room counts as lit for a 5 minute slot when any of its lights reported on in that slot.
lights as (
  select day, room, round(count(distinct slot) / 12.0, 2) as hours
  from (
    select day, room, date_bin('5 minutes', recorded_at, timestamptz '2026-01-01') as slot
    from rw
    where kind = 'light' and state->>'power' = 'true' and coalesce(state->>'online', 'true') <> 'false'
  ) on_slots
  group by day, room
),
heater as (
  select day,
         round(avg((state->>'tank_pct')::numeric), 0) as tank_avg,
         min((state->>'tank_pct')::numeric) as tank_min,
         round(sum(hours) filter (where state->>'running' is not null)::numeric, 2) as heating,
         round(sum(hours) filter (where state->>'running' ilike '%element%')::numeric, 2) as element,
         round(sum(hours) filter (where state->>'mode' = 'off' or state->>'power' = 'false')::numeric, 2) as off
  from rw where kind = 'water_heater'
  group by day
),
tv as (
  select day, round(sum(hours)::numeric, 2) as hours
  from rw where kind = 'tv' and state->>'screen' = 'on' and coalesce(state->>'online', 'true') <> 'false'
  group by day
),
cam as (
  select distinct on (d.id, e->>'t') d.name as camera, (e->>'t')::timestamptz as t, e->>'kind' as kind, (e->>'person')::boolean as person
  from public.home_readings r
  join public.home_devices d on d.id = r.device_id and d.kind = 'camera'
  cross join lateral jsonb_array_elements(coalesce(r.state->'events', '[]'::jsonb)) e
  where r.recorded_at >= (select since from win) and e->>'t' is not null
),
act as (
  select c.id, c.device_id, coalesce(d.name, c.device_id) as device_name, d.kind, c.command, c.source, c.status, c.requested_at as t
  from public.home_commands c
  left join public.home_devices d on d.id = c.device_id
  where c.requested_at >= (select since from win)
  order by c.requested_at desc
  limit 200
)
select jsonb_build_object(
  'days', greatest(1, least(coalesce(p_days, 14), 90)),
  'energy', coalesce((select jsonb_agg(jsonb_build_object('d', day, 'kwh', kwh, 'cost', cost) order by day)
                      from public.home_energy_daily where day >= current_date - 400), '[]'::jsonb),
  'lights', coalesce((select jsonb_agg(jsonb_build_object('d', day, 'room', room, 'hours', hours) order by day, room) from lights), '[]'::jsonb),
  'heater', coalesce((select jsonb_agg(jsonb_build_object('d', day, 'tank_avg', tank_avg, 'tank_min', tank_min, 'heating', heating, 'element', element, 'off', off) order by day) from heater), '[]'::jsonb),
  'tv', coalesce((select jsonb_agg(jsonb_build_object('d', day, 'hours', hours) order by day) from tv), '[]'::jsonb),
  'camera', coalesce((select jsonb_agg(jsonb_build_object('camera', camera, 't', t, 'kind', kind, 'person', person) order by t desc)
                      from cam where t >= (select since from win)), '[]'::jsonb),
  'activity', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'device_id', device_id, 'device_name', device_name, 'kind', kind,
                        'command', command, 'source', source, 'status', status, 't', t) order by t desc) from act), '[]'::jsonb)
);
$$;

revoke all on function public.home_analytics(int) from public, anon, authenticated;
grant execute on function public.home_analytics(int) to service_role;
