-- 02 LOCKDOWN — run ONLY after all three phones have opened the NEW app,
-- entered a PIN, and can see hours, the plan, and a photo.
-- Until this runs, anyone with the public anon key can still read and edit cleaner data.
-- After this runs, the previous cleaner app (anon key, shared PIN checked in the browser) stops working.
-- That is intentional. Do not run it before the new app is confirmed.
--
-- Reservoir Stays shares this project. This script only drops the cleaner policies
-- named below, revokes anon on those six cleaner tables, and sets the task-photos
-- bucket to private. It does not touch rs_* tables, other buckets, or edge functions.

drop policy if exists "app_all" on public.hours_entries;
drop policy if exists "app_read" on public.airbnb_bookings;
drop policy if exists "app_all_issues" on public.maintenance_issues;
drop policy if exists "app_all_settings" on public.app_settings;
drop policy if exists "app_all_tasks" on public.tasks;
drop policy if exists "app_all_cleaning" on public.cleaning_blocks;

drop policy if exists "app_upload_task_photos" on storage.objects;
drop policy if exists "app_read_task_photos" on storage.objects;
drop policy if exists "app_delete_task_photos" on storage.objects;

update storage.buckets set public = false where id = 'task-photos';

revoke all on table public.hours_entries from anon;
revoke all on table public.airbnb_bookings from anon;
revoke all on table public.maintenance_issues from anon;
revoke all on table public.app_settings from anon;
revoke all on table public.tasks from anon;
revoke all on table public.cleaning_blocks from anon;

-- Plaintext PIN. Hashes live in cleaner_private.pin_credentials, which anon cannot read.
alter table public.app_settings drop column if exists pin;

-- Written by the app and never read. Task assignment is no longer a column:
-- every task is Angelica's, and maintenance issues keep their own assigned_to.
alter table public.tasks drop column if exists notified_cleaner;
alter table public.tasks drop column if exists notified_owners;
alter table public.tasks drop column if exists assigned_to;
alter table public.maintenance_issues drop column if exists notified;
drop index if exists public.maintenance_issues_notified_resolved_idx;

notify pgrst, 'reload schema';
