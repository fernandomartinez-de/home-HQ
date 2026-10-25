create extension if not exists pg_net;
create extension if not exists pg_cron;

-- Calls an appliance function with the home API key from Vault.
create or replace function public.home_call_function(fn text, body jsonb)
returns bigint
language sql
security definer
set search_path = ''
as $$
  select net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/' || fn,
    body := body,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-home-key', (select decrypted_secret from vault.decrypted_secrets where name = 'home_api_key')
    ),
    timeout_milliseconds := 30000
  );
$$;
revoke all on function public.home_call_function(text, jsonb) from public, anon, authenticated;

-- Poll every appliance every 5 minutes for history.
select cron.schedule('home-poll-rheem', '*/5 * * * *', $$select public.home_call_function('rheem', '{"action":"poll"}')$$);
select cron.schedule('home-poll-govee', '*/5 * * * *', $$select public.home_call_function('govee', '{"action":"poll"}')$$);
