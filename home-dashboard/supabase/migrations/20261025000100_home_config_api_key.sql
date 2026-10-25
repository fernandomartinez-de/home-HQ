-- Private settings for home control. Holds only the hash of the API key the dashboard
-- and scheduled jobs send to the appliance functions. The key itself lives in Vault
-- under the name 'home_api_key'.
create table public.home_config (
  id               smallint primary key default 1 check (id = 1),
  api_key_sha256   text not null,
  updated_at       timestamptz not null default now()
);
alter table public.home_config enable row level security;
comment on table public.home_config is 'Private home control settings (API key hash). Read only by the appliance functions.';

do $$
declare k text := encode(extensions.gen_random_bytes(32), 'hex');
begin
  perform vault.create_secret(k, 'home_api_key', 'Key the home dashboard and pg_cron send to appliance functions (x-home-key)');
  insert into public.home_config (api_key_sha256) values (encode(extensions.digest(k, 'sha256'), 'hex'));
end $$;
