# Owner setup

Do these steps in order. The app on the phones keeps working through step 6. Step 8 is what actually stops a stranger with the public page from reading or editing data. Step 8 too early locks Angelica out.

The repo stays public. That is fine once this list is done. The publishable key in `cleaner.html` is meant to be public. The PIN hashes, the Airbnb feed URLs, and the service-role key are not.

This Supabase project also runs Reservoir Stays (`rs_rooms`, `rs_bookings`, the other `rs_*` tables, its photo storage, and its photo edge functions). The SQL in this repo does not modify those. Three project-wide settings stay as they are:

- Leave **email sign-up** on. It is on today. Reservoir Stays may register guests with it. The cleaner app does not need it off: someone who signs up has no cleaner role, so the cleaner policies deny them.
- Leave **anonymous sign-in** as it is. It is off today. Do not toggle it.
- Do **not** rotate the publishable key or the JWT secret. Reservoir Stays uses this same project key. After step 8 the leaked key still cannot read the cleaner tables, and it already cannot read the `rs_*` tables. Rotating it would take Reservoir Stays down until every one of its clients is updated.

## 1. Regenerate the Airbnb calendar links — but not until step 7

The three export URLs were committed in `.github/scripts/sync-airbnb.js`. Anyone who clones the repo, including its history, has those tokens. They keep working until you reset them. **Do not click Reset until the new sync script is on `main` and the GitHub secrets exist** (step 6 and step 7). Resetting earlier makes the copy still in git the only copy, and that copy is about to be deleted from the code, so the sync would have no working URL.

When you do reset (step 7), do it once per listing:

1. Sign in at [airbnb.com.au](https://www.airbnb.com.au) as the host.
2. Click **Calendar** and select the listing.
3. Click **Availability**.
4. Under **Connect calendars**, click **Connect to another website**. On some accounts the label is **Sync calendars**.
5. In the export section, click **Reset URL** (sometimes **Reset link**). The old link stops working immediately, with no grace period. If there is no reset control, copy the link that is shown and compare the `t=` value with the URL that used to be in `sync-airbnb.js`. If `t=` is unchanged, the leaked token is still live. Ask Airbnb support to regenerate the export link, then continue.
6. Copy the entire new link, from `https://` through the new `t=` value. Paste it only into the GitHub secret in step 7. Do not put it in the repo, a doc, an email, or a chat.

Match listings to secrets by the number between `/ical/` and `.ics` (that number is the listing id, not the secret):

| Secret | Listing id |
|---|---|
| `AIRBNB_ICAL_ROOM_1` | `1177127470457652236` |
| `AIRBNB_ICAL_ROOM_2` | `1177134716734273232` |
| `AIRBNB_ICAL_ROOM_3` | `1177136108707135736` |

## 2. Supabase — prepare, while the current app still works

Open the project `yslpaxzfpdzxzhuspmij` → **SQL Editor** → New query. Paste `supabase/migrations/20261121090000_prepare_auth.sql` and run it. You should see success. This adds owner/cleaner login, lets Low priority save, and adds booking-override columns. It does **not** remove the old anon access and it does **not** remove the plaintext PIN, so the app Angelica has open today keeps working.

### Do not change Auth provider settings

**Authentication → Sign In / Providers → Email.** Confirm, and then leave it:

- “Allow new users to sign up” stays **on**. Reservoir Stays may use it. A new account still cannot open the cleaner app, because only the two users below get a row in `app_roles`.
- Anonymous sign-ins stay **off**. That is already the project setting. Do not turn them on for the cleaner app, and do not go looking for a way to force them off if a future Reservoir Stays change has turned them on.
- Email auth stays on. The PIN function signs in with it.

The two users you add next are extra accounts for this app. They do not replace `rs_admin_users` or any Reservoir Stays login.

### Create the two accounts

**Authentication → Users → Add user.** Check **Auto Confirm User** so no email is sent. Use a long random password for each (Terminal: `openssl rand -base64 24`). Do not use the PIN as this password.

| Account | Email | Password goes in |
|---|---|---|
| Cleaner | `angussullivan+abnb-cleaner@gmail.com` | Supabase secret `APP_CLEANER_PASSWORD` |
| Owner (Angus and Jenna share this) | `angussullivan+abnb-owner@gmail.com` | Supabase secret `APP_OWNER_PASSWORD` |

Plus-addressing lands in Angus's Gmail if Supabase ever sends mail. The two passwords must be different from each other and must not be written into the repo.

### Link the accounts to roles

SQL Editor, with the emails you actually created:

```sql
insert into public.app_roles (user_id, role)
select id, 'cleaner' from auth.users where lower(email) = lower('angussullivan+abnb-cleaner@gmail.com')
on conflict (user_id) do update set role = excluded.role;

insert into public.app_roles (user_id, role)
select id, 'owner' from auth.users where lower(email) = lower('angussullivan+abnb-owner@gmail.com')
on conflict (user_id) do update set role = excluded.role;

-- Expect two rows, each with a role. If a role is blank, the email did not match.
select u.email, r.role
from auth.users u
left join public.app_roles r on r.user_id = u.id
order by u.email;
```

### Choose the two PINs

Pick two different 4-digit PINs. Do not reuse `1234`. Tell Angelica only the cleaner PIN. Angus and Jenna share the owner PIN; it is what opens Settings and Clear all hours.

SQL Editor — replace the quoted digits, run once, then delete this query from the editor history (the history stores the plaintext):

```sql
insert into cleaner_private.pin_credentials (role, pin_hash) values
  ('cleaner', extensions.crypt('CLEANER_PIN_HERE', extensions.gen_salt('bf'))),
  ('owner',   extensions.crypt('OWNER_PIN_HERE', extensions.gen_salt('bf')))
on conflict (role) do update
  set pin_hash = excluded.pin_hash, updated_at = now();

-- Expect two rows. This does not print the PINs.
select role, updated_at from cleaner_private.pin_credentials order by role;
```

A 4-digit PIN can be guessed. The database allows 8 failures per network address per 15 minutes, and 40 failures across everyone in that window, then it locks for the rest of the window. Change the PIN from Settings if that starts happening for no reason.

### Deploy the PIN function

**Edge Functions → Secrets**, set exactly:

| Secret | Value |
|---|---|
| `APP_CLEANER_EMAIL` | `angussullivan+abnb-cleaner@gmail.com` |
| `APP_CLEANER_PASSWORD` | the cleaner account's long password |
| `APP_OWNER_EMAIL` | `angussullivan+abnb-owner@gmail.com` |
| `APP_OWNER_PASSWORD` | the owner account's long password |

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are injected by Supabase. Do not copy the service-role key into the repo.

Deploy only `supabase/functions/pin-login`, with JWT verification **off**. The publishable key is not a JWT; if verification stays on, every PIN fails before the function runs. Do not redeploy or edit the Reservoir Stays photo functions.

From a laptop with the [Supabase CLI](https://supabase.com/docs/guides/cli), in this repo:

```bash
npx supabase login
npx supabase link --project-ref yslpaxzfpdzxzhuspmij
npx supabase functions deploy pin-login --no-verify-jwt
```

Or in the dashboard: **Edge Functions → Deploy a new function → Via Editor**, name it `pin-login`, paste `supabase/functions/pin-login/index.ts`, and turn **off** “Enforce JWT verification” before deploying. Confirm the toggle is off after deploy (Function → Details).

### Prove the PIN works before you merge

Replace the PIN and the publishable key (Project Settings → API Keys, the publishable key that is already in `cleaner.html`):

```bash
curl -sS -D - -o /tmp/pin.json -X POST \
  'https://yslpaxzfpdzxzhuspmij.supabase.co/functions/v1/pin-login' \
  -H 'Content-Type: application/json' \
  -H 'apikey: PASTE_PUBLISHABLE_KEY' \
  -H 'Authorization: Bearer PASTE_PUBLISHABLE_KEY' \
  -d '{"pin":"CLEANER_PIN"}'
```

- `HTTP/2 200` and `"role":"cleaner"` in `/tmp/pin.json` — good. Repeat with the owner PIN and expect `"role":"owner"`.
- `401` with a JWT error — verification is still on. Redeploy with `--no-verify-jwt`.
- `500` and “not configured” — a secret name is wrong, or the Auth password does not match the user you created. The function logs in the dashboard say which one.
- `401` “Incorrect PIN” — the hash query did not match. Re-run the PIN insert.

Do not paste the curl output anywhere; it contains a session token. Wrong PINs are rate-limited, so don't loop.

## 3. GitHub Actions secrets

Repo → **Settings → Secrets and variables → Actions**. Add:

| Secret | Value |
|---|---|
| `NOTIFY_CLEANER_EMAIL` | `angelicasuesscun@icloud.com` |
| `NOTIFY_OWNER_EMAILS` | `angussullivan@gmail.com, jenna4134@gmail.com` |
| `GOOGLE_CALENDAR_ID` | `jennangusplan@gmail.com` |
| `AIRBNB_ICAL_ROOM_1` | the **current** export URL for listing `1177127470457652236` |
| `AIRBNB_ICAL_ROOM_2` | the **current** export URL for listing `1177134716734273232` |
| `AIRBNB_ICAL_ROOM_3` | the **current** export URL for listing `1177136108707135736` |

Use the URLs that work today for this step, even though they are the leaked ones. Step 7 replaces them. The new script reads these secrets and will not sync at all if they are missing.

Leave the existing secrets as they are: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `GOOGLE_SERVICE_ACCOUNT_JSON`. The service-role key bypasses RLS, which is how the scripts keep writing bookings after lockdown. Do not rotate it as part of this change.

## 4. Merge

Merge the pull request into `main`. GitHub Pages updates the live app from `main`. GitHub's own hourly schedule is removed in this change, so nothing syncs again until step 5. The phones keep the old page until they reload. The old page still works, because you have not run the lockdown SQL.

## 5. cron-job.org — hourly syncs

GitHub's scheduler was starting the Airbnb and calendar syncs hours late, so the “check-in within 24h” email arrived late. The email workflow already avoids that by being started from cron-job.org. Do the same for the two syncs. Do this the same day you merge, or bookings and the Google calendar stop updating.

Create a fine-grained personal access token:

1. GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. Resource owner: `angussullivan`. Repository access: **Only select repositories → cleaner-app**.
3. Permissions: **Actions → Read and write**. Nothing else.
4. Copy the token. It is shown once. Store it in cron-job.org only.

In cron-job.org, two jobs. Same account you already use for the 7pm and 8pm emails.

**Job: Airbnb sync**

- URL: `https://api.github.com/repos/angussullivan/cleaner-app/actions/workflows/sync-airbnb.yml/dispatches`
- Schedule: every hour at minute 0 (`0 * * * *`). Timezone does not matter for an hourly job.
- Method: `POST`
- Body: `{"ref":"main"}`
- Headers:
  - `Authorization: Bearer YOUR_TOKEN`
  - `Accept: application/vnd.github+json`
  - `Content-Type: application/json`
  - `User-Agent: cron-job.org`
  - `X-GitHub-Api-Version: 2022-11-28`
- A success response is **204** with an empty body. That is normal.

**Job: Calendar sync**

- URL: `https://api.github.com/repos/angussullivan/cleaner-app/actions/workflows/sync-calendar.yml/dispatches`
- Schedule: every hour at minute 30 (`30 * * * *`)
- Same method, body, and headers.

Run each job once by hand. In GitHub → **Actions**, both workflows should go green. If Airbnb sync fails on a missing secret, the secret name in the log is the one to add. The log does not print the feed URL.

You can also run them from the Actions tab with **Run workflow** while you are setting the cron jobs up.

## 6. Phones, before lockdown

On Angus's phone, Jenna's phone, and Angelica's phone:

1. Open `https://angussullivan.github.io/cleaner-app/cleaner.html?v=2` (the `?v=2` avoids a cached copy of the old page).
2. Enter the PIN. Angus and Jenna use the owner PIN. Angelica uses the cleaner PIN.
3. Confirm hours, the Plan tab, and a task photo all load.
4. As an owner, open Settings. The cleaner PIN must not show Settings or **Clear all hours**. Angelica should see “You're signed in as the cleaner” and a Lock button.

Leave the app logged in. It remembers the session, so the PIN is not required on every open. Lock signs out.

If this fails, **do not run step 8**. The old anon policies are still in place, so reverting the merge puts the previous app back. Fix the PIN function or the role rows first.

Do not add or correct a booking until step 5 has completed once. The previous sync script would delete a hand-added booking on its next run.

## 7. Reset the Airbnb URLs and update the secrets

Now do the reset in step 1 for all three listings. Update `AIRBNB_ICAL_ROOM_1`, `AIRBNB_ICAL_ROOM_2`, and `AIRBNB_ICAL_ROOM_3` with the new links. Run the Airbnb sync workflow once and confirm it is green and the Plan tab still shows the right rooms.

Also confirm, for each listing, that any other tool which imported the old link (another calendar, a channel manager) is updated. Resetting kills every consumer of that link at once.

## 8. Lock the database

Only after step 6 succeeded on all three phones.

SQL Editor → paste `supabase/migrations/20261121100000_lockdown.sql` → run.

This drops anon access on the cleaner tables only, makes the `task-photos` bucket private, deletes the plaintext PIN column, and drops the unused `notified_*` / legacy task-assignment columns. It does not change `rs_*` tables, other storage buckets, or edge functions. The service-role scripts are unaffected.

Reload each phone (the `?v=2` URL, or lock and enter the PIN again). Hours, the plan, and a photo must still load. A private window with no PIN must not show any bookings: the page stops at the PIN screen, and the publishable key alone gets nothing from the API.

## 9. Do not rotate the publishable key

Skip this. Reservoir Stays uses the same Supabase project, so it uses the same publishable key. Rotating that key, or disabling the legacy anon JWT, takes Reservoir Stays offline until every one of its apps is edited. Step 8 already stops the leaked key from reading or writing cleaner data, and that key already cannot read the `rs_*` tables.

Also do not rotate the JWT secret or the secret/service-role key. The JWT secret was never in the repo. Rotating it signs everyone out, including Reservoir Stays, and can invalidate `SUPABASE_SERVICE_KEY`, which stops the GitHub scripts.

## 10. GitHub repo description

If it still says “RSSL website” or points at reservoirlaundry.com.au:

- **Description:** `67 Res ABNB Manager — hours, cleaning plan, and tasks for the Reservoir St Airbnbs`
- **Website:** `https://angussullivan.github.io/cleaner-app/`

GitHub → repo → **Settings** (the gear at the top of the repo home page has Description and Website).

## What you can change later without SQL

- Cleaner PIN, owner PIN, cleaner name, and the in-app “Send Report” recipients: owner PIN → Settings. The automatic 7pm/8pm emails use `NOTIFY_CLEANER_EMAIL` and `NOTIFY_OWNER_EMAILS`, not that list.
- A wrong or missing Airbnb booking: owner PIN → Plan → **Add or correct a booking**. Leave “Keep these dates” on. The next sync will not overwrite or delete it. **Hide from schedule** keeps a bad feed row from coming back. Bookings you added yourself can be deleted; feed rows cannot, or the next sync would recreate them.
- One wrong hours entry can still be deleted by the cleaner. **Clear all hours** is owner-only, and the database rejects it from the cleaner account.
