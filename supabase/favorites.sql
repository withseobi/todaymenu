-- Initial setup for the favorites feature. Already applied to todaymenu-x9sn.
-- For a new project: paste this file into Supabase SQL Editor and click Run.
create table public.favorites (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  recipe_id bigint not null check (recipe_id > 0),
  created_at timestamptz not null default now(),
  constraint favorites_user_recipe_unique unique (user_id, recipe_id)
);

alter table public.favorites enable row level security;

revoke all on table public.favorites from public, anon, authenticated;
grant select, insert, delete on table public.favorites to authenticated;

create policy favorites_select_own
on public.favorites for select to authenticated
using ((select auth.uid()) = user_id);

create policy favorites_insert_own
on public.favorites for insert to authenticated
with check ((select auth.uid()) = user_id);

create policy favorites_delete_own
on public.favorites for delete to authenticated
using ((select auth.uid()) = user_id);
