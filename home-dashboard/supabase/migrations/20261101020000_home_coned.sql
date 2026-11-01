-- Con Edison: the coned function (coned/functions/coned) registers the electric meter as kind 'meter'
-- and keeps daily usage and cost in home_energy_daily for history views.

alter table public.home_devices drop constraint home_devices_kind_check;
alter table public.home_devices add constraint home_devices_kind_check
  check (kind in ('water_heater','ac','light','tv','camera','meter'));

alter table public.home_devices drop constraint home_devices_provider_check;
alter table public.home_devices add constraint home_devices_provider_check
  check (provider in ('rheem','esp32','govee','tv','ring','coned'));

create table if not exists public.home_energy_daily (
  account    text not null,
  day        date not null,
  kwh        numeric,
  cost       numeric,
  updated_at timestamptz not null default now(),
  primary key (account, day)
);
alter table public.home_energy_daily enable row level security; -- service role only

-- Sign in details for providers that need them on every poll (Con Edison has no refresh token).
-- Kept encrypted in Supabase Vault; only the service role (edge functions) can call these.
create or replace function public.home_secret_set(p_name text, p_secret text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if p_name not like 'login\_%' then raise exception 'secret name must start with login_'; end if;
  select id into v_id from vault.secrets where name = p_name;
  if v_id is null then perform vault.create_secret(p_secret, p_name);
  else perform vault.update_secret(v_id, p_secret); end if;
end $$;

create or replace function public.home_secret_get(p_name text) returns text
language sql security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets where name = p_name and p_name like 'login\_%';
$$;

create or replace function public.home_secret_delete(p_name text) returns void
language sql security definer set search_path = '' as $$
  delete from vault.secrets where name = p_name and p_name like 'login\_%';
$$;

revoke all on function public.home_secret_set(text, text) from public, anon, authenticated;
revoke all on function public.home_secret_get(text) from public, anon, authenticated;
revoke all on function public.home_secret_delete(text) from public, anon, authenticated;
grant execute on function public.home_secret_set(text, text) to service_role;
grant execute on function public.home_secret_get(text) to service_role;
grant execute on function public.home_secret_delete(text) to service_role;

-- Every 2 hours (does nothing until Con Edison is connected). Runs in the background because a
-- sign in can take longer than pg_net's 30 second timeout.
select cron.schedule('home-poll-coned', '7 */2 * * *', $$select public.home_call_function('coned', '{"action":"poll","background":true}')$$);
