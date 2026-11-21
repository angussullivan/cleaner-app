-- 01 PREPARE — run this on the LIVE project FIRST, before merging the app change.
-- The current phone app keeps working: anon policies and the pin column stay.
-- Do not put real PINs in this file. Set them with the statement in docs/OWNER-SETUP.md.
-- Safe to re-run.

create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
revoke all on schema private from public;
revoke all on schema private from anon, authenticated;

create table if not exists private.pin_credentials (
    role       text primary key check (role in ('cleaner', 'owner')),
    pin_hash   text not null,
    updated_at timestamptz not null default now()
);

create table if not exists private.pin_attempts (
    id         bigint generated always as identity primary key,
    ip         text not null,
    ok         boolean not null,
    created_at timestamptz not null default now()
);

create index if not exists pin_attempts_created_idx on private.pin_attempts (created_at);

alter table private.pin_credentials enable row level security;
alter table private.pin_attempts enable row level security;
revoke all on private.pin_credentials from public, anon, authenticated, service_role;
revoke all on private.pin_attempts from public, anon, authenticated, service_role;

create table if not exists public.app_roles (
    user_id uuid primary key references auth.users(id) on delete cascade,
    role    text not null check (role in ('cleaner', 'owner'))
);

alter table public.app_roles enable row level security;
revoke all on public.app_roles from public, anon, authenticated;

-- Who is calling. security definer so the table itself stays unreadable.
create or replace function public.current_app_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
    select role from public.app_roles where user_id = auth.uid()
$$;

revoke all on function public.current_app_role() from public, anon;
grant execute on function public.current_app_role() to authenticated, service_role;

-- Checks a 4-digit PIN and rate-limits guesses. Granted to service_role only;
-- the pin-login edge function is the caller. Returns 'cleaner', 'owner',
-- 'locked', or null.
create or replace function public.verify_app_pin(candidate text, client_ip text)
returns text
language plpgsql
security definer
set search_path = private, public, extensions
as $$
declare
    v_ip text := left(coalesce(nullif(trim(client_ip), ''), 'unknown'), 64);
    v_ip_fails int;
    v_all_fails int;
    v_role text;
begin
    perform pg_sleep(0.35);

    delete from private.pin_attempts where created_at < now() - interval '1 day';

    select count(*) into v_ip_fails
    from private.pin_attempts
    where ip = v_ip and not ok and created_at > now() - interval '15 minutes';

    select count(*) into v_all_fails
    from private.pin_attempts
    where not ok and created_at > now() - interval '15 minutes';

    if v_ip_fails >= 8 or v_all_fails >= 40 then
        return 'locked';
    end if;

    if candidate is null or candidate !~ '^[0-9]{4}$' then
        insert into private.pin_attempts (ip, ok) values (v_ip, false);
        return null;
    end if;

    select role into v_role
    from private.pin_credentials
    where pin_hash = extensions.crypt(candidate, pin_hash)
    order by case role when 'owner' then 0 else 1 end
    limit 1;

    if v_role is null then
        insert into private.pin_attempts (ip, ok) values (v_ip, false);
        return null;
    end if;

    insert into private.pin_attempts (ip, ok) values (v_ip, true);
    return v_role;
end;
$$;

revoke all on function public.verify_app_pin(text, text) from public, anon, authenticated;
grant execute on function public.verify_app_pin(text, text) to service_role;

create or replace function public.set_app_pin(target_role text, new_pin text)
returns void
language plpgsql
security definer
set search_path = private, public, extensions
as $$
declare
    other_hash text;
begin
    if public.current_app_role() is distinct from 'owner' then
        raise exception 'Only an owner can change PINs';
    end if;
    if target_role not in ('cleaner', 'owner') then
        raise exception 'Unknown role';
    end if;
    if new_pin !~ '^[0-9]{4}$' then
        raise exception 'PIN must be exactly 4 digits';
    end if;

    select pin_hash into other_hash
    from private.pin_credentials
    where role <> target_role;

    if other_hash is not null and other_hash = extensions.crypt(new_pin, other_hash) then
        raise exception 'Cleaner PIN and owner PIN must be different';
    end if;

    insert into private.pin_credentials (role, pin_hash)
    values (target_role, extensions.crypt(new_pin, extensions.gen_salt('bf')))
    on conflict (role) do update
        set pin_hash = excluded.pin_hash,
            updated_at = now();
end;
$$;

revoke all on function public.set_app_pin(text, text) from public, anon;
grant execute on function public.set_app_pin(text, text) to authenticated;

create or replace function public.clear_all_hours()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if public.current_app_role() is distinct from 'owner' then
        raise exception 'Only an owner can clear all hours';
    end if;
    delete from public.hours_entries;
end;
$$;

revoke all on function public.clear_all_hours() from public, anon;
grant execute on function public.clear_all_hours() to authenticated;

-- Bookings the owner adds or corrects. The sync script will not overwrite
-- source = 'manual', pinned, or suppressed rows.
alter table public.airbnb_bookings add column if not exists source text not null default 'ical';
alter table public.airbnb_bookings add column if not exists pinned boolean not null default false;
alter table public.airbnb_bookings add column if not exists suppressed boolean not null default false;
alter table public.airbnb_bookings drop constraint if exists airbnb_bookings_source_check;
alter table public.airbnb_bookings add constraint airbnb_bookings_source_check check (source in ('ical', 'manual'));

-- Task form offers Low. The old check allowed only normal/urgent, so those saves failed.
alter table public.tasks drop constraint if exists tasks_priority_check;
alter table public.tasks drop constraint if exists priority_values;
alter table public.tasks add constraint tasks_priority_check check (priority in ('low', 'normal', 'urgent'));

-- Authenticated policies sit ALONGSIDE the existing anon policies.
-- Dropping the anon policies is the lockdown migration, not this one.
drop policy if exists "hours_member_all" on public.hours_entries;
create policy "hours_member_all" on public.hours_entries
    for all to authenticated
    using (public.current_app_role() in ('cleaner', 'owner'))
    with check (public.current_app_role() in ('cleaner', 'owner'));

drop policy if exists "bookings_cleaner_read" on public.airbnb_bookings;
create policy "bookings_cleaner_read" on public.airbnb_bookings
    for select to authenticated
    using (public.current_app_role() = 'cleaner' and not suppressed);

drop policy if exists "bookings_owner_all" on public.airbnb_bookings;
create policy "bookings_owner_all" on public.airbnb_bookings
    for all to authenticated
    using (public.current_app_role() = 'owner')
    with check (public.current_app_role() = 'owner');

drop policy if exists "issues_member_all" on public.maintenance_issues;
create policy "issues_member_all" on public.maintenance_issues
    for all to authenticated
    using (public.current_app_role() in ('cleaner', 'owner'))
    with check (public.current_app_role() in ('cleaner', 'owner'));

drop policy if exists "tasks_member_all" on public.tasks;
create policy "tasks_member_all" on public.tasks
    for all to authenticated
    using (public.current_app_role() in ('cleaner', 'owner'))
    with check (public.current_app_role() in ('cleaner', 'owner'));

drop policy if exists "cleaning_member_all" on public.cleaning_blocks;
create policy "cleaning_member_all" on public.cleaning_blocks
    for all to authenticated
    using (public.current_app_role() in ('cleaner', 'owner'))
    with check (public.current_app_role() in ('cleaner', 'owner'));

drop policy if exists "settings_member_read" on public.app_settings;
create policy "settings_member_read" on public.app_settings
    for select to authenticated
    using (public.current_app_role() in ('cleaner', 'owner'));

drop policy if exists "settings_owner_write" on public.app_settings;
create policy "settings_owner_write" on public.app_settings
    for all to authenticated
    using (public.current_app_role() = 'owner')
    with check (public.current_app_role() = 'owner');

drop policy if exists "auth_insert_task_photos" on storage.objects;
create policy "auth_insert_task_photos" on storage.objects
    for insert to authenticated
    with check (bucket_id = 'task-photos' and public.current_app_role() in ('cleaner', 'owner'));

drop policy if exists "auth_read_task_photos" on storage.objects;
create policy "auth_read_task_photos" on storage.objects
    for select to authenticated
    using (bucket_id = 'task-photos' and public.current_app_role() in ('cleaner', 'owner'));

drop policy if exists "auth_delete_task_photos" on storage.objects;
create policy "auth_delete_task_photos" on storage.objects
    for delete to authenticated
    using (bucket_id = 'task-photos' and public.current_app_role() in ('cleaner', 'owner'));

-- The plaintext PIN stays for the old app until lockdown, but a signed-in
-- session (the new app) must not be able to read it.
do $$
begin
    if exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'app_settings' and column_name = 'pin'
    ) then
        execute 'revoke select (pin) on public.app_settings from authenticated';
    end if;
end $$;

notify pgrst, 'reload schema';
