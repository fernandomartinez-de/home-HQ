-- Reusable login sessions for appliance clouds (e.g. Rheem EcoNet), so functions don't log in on
-- every call and trip rate limits. Service role only.
create table public.home_provider_sessions (
  provider    text primary key,
  session     jsonb not null,
  created_at  timestamptz not null default now()
);
alter table public.home_provider_sessions enable row level security;
comment on table public.home_provider_sessions is 'Cached appliance cloud login sessions. Read and written only by appliance functions.';
