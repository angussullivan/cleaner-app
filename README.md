# 67 Res ABNB Manager

A single-file mobile PWA for the Reservoir St Airbnbs. Angelica logs hours, follows the checkout plan, and works through tasks. Angus and Jenna manage settings, bookings, and maintenance issues.

The app is served by GitHub Pages: <https://angussullivan.github.io/cleaner-app/>

**Owners: the security changes need a one-time setup before they protect anything.** Follow [docs/OWNER-SETUP.md](docs/OWNER-SETUP.md) in order. Merging the code alone does not lock the database, and running the lockdown SQL too early locks the phones out.

## Files

- `cleaner.html` — the app
- `supabase/migrations/` — SQL to run on the existing Supabase project
- `supabase/functions/pin-login/` — exchanges a PIN for a Supabase session
- `.github/scripts/send-emails.js` — 7pm reminder and 8pm summaries
- `.github/scripts/sync-airbnb.js` — hourly Airbnb iCal sync and 24h change alerts
- `.github/scripts/sync-calendar.js` — hourly Google Calendar sync of manual cleaning blocks
- `.github/workflows/` — GitHub Actions, all started by cron-job.org (`workflow_dispatch`), not GitHub's scheduler

## How access works

The publishable Supabase key in `cleaner.html` is public, and the same Supabase project also runs Reservoir Stays. Do not rotate that key, and do not turn off email sign-up: both are shared. After lockdown the key cannot read or change cleaner data. Angelica, Angus, and Jenna enter a 4-digit PIN. An edge function checks it against a hash the anon key cannot read, then signs in a pre-created user:

- Cleaner PIN — hours, plan, tasks, issues, cleaning blocks. No settings and no "Clear all hours".
- Owner PIN (shared by Angus and Jenna) — the same, plus settings, PIN changes, clearing hours, and adding or correcting bookings.

Bookings added or corrected in the app are marked so the hourly sync does not overwrite them. Checkout cleans (11:00–14:00) are created even when the day already has a house clean. Task priority may be Low, Normal, or Urgent. The plan uses Australia/Sydney dates. Photos: up to 6 on a task, up to 3 on an issue, in a private bucket.

## GitHub Actions secrets

| Secret | Used by |
|---|---|
| `SUPABASE_URL` | all three scripts |
| `SUPABASE_SERVICE_KEY` | all three scripts (bypasses RLS; do not rotate it unless you update this secret in the same sitting) |
| `GMAIL_USER` | send-emails, sync-airbnb |
| `GMAIL_APP_PASSWORD` | send-emails, sync-airbnb |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | sync-calendar |
| `GOOGLE_CALENDAR_ID` | sync-calendar |
| `AIRBNB_ICAL_ROOM_1` | sync-airbnb |
| `AIRBNB_ICAL_ROOM_2` | sync-airbnb |
| `AIRBNB_ICAL_ROOM_3` | sync-airbnb |
| `NOTIFY_CLEANER_EMAIL` | send-emails, sync-airbnb |
| `NOTIFY_OWNER_EMAILS` | send-emails, sync-airbnb (comma-separated) |

The iCal values are the full export URLs from Airbnb. They are secrets. Do not commit them.

## Tests

```bash
node --test tests/*.test.mjs
```
