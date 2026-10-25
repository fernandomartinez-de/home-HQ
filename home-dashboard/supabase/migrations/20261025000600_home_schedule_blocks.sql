-- Schedules become time blocks: a start (at_time) and a stop (end_time). Outside blocks the
-- device is off. A stop earlier than the start means the block runs past midnight.
alter table public.home_schedules add column if not exists end_time time;
alter table public.home_schedules add column if not exists last_end_run_at timestamptz;
comment on column public.home_schedules.end_time is 'When the block stops; the device turns off then. Earlier than at_time means it ends the next day.';

-- One time conversion from Rheem style slots (start only, "off" slots in between): each
-- heating slot stops when the next slot starts, then the off slots are dropped.
with ordered as (
  select id, at_time,
         lead(at_time) over (partition by device_id, days[1] order by at_time) as next_start,
         first_value(at_time) over (partition by device_id, days[1] order by at_time) as first_start
  from public.home_schedules where end_time is null
)
update public.home_schedules s set end_time = coalesce(o.next_start, o.first_start)
from ordered o where o.id = s.id;
delete from public.home_schedules where command->>'mode' = 'off';
