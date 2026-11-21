// Fetches Airbnb iCal feeds for all 3 rooms and upserts upcoming bookings into Supabase.
// Feed URLs (they contain a secret token) come from GitHub Actions secrets, never from the repo.
// "Airbnb (Not available)" system/owner blocks are filtered out — only actual guest
// reservations (summary != "not available") are stored and shown in the app.
// Rows the owner pinned, hid, or added by hand are left alone so a later sync cannot clobber them.
// If any reservation with a check-in within the next 24h has changed, sends an alert email.

import { pathToFileURL } from 'node:url';

const ROOM_SPECS = [
    { name: 'Room 1', env: 'AIRBNB_ICAL_ROOM_1' },
    { name: 'Room 2', env: 'AIRBNB_ICAL_ROOM_2' },
    { name: 'Room 3', env: 'AIRBNB_ICAL_ROOM_3' },
];

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

export function parseEmailList(value) {
    return String(value || '')
        .split(/[,;]+/)
        .map(s => s.trim())
        .filter(s => s.includes('@'));
}

export function roomFeedsFromEnv(env) {
    const missing = ROOM_SPECS.filter(r => !String(env[r.env] || '').trim()).map(r => r.env);
    const rooms = ROOM_SPECS.map(r => ({ name: r.name, url: String(env[r.env] || '').trim() }));
    return { rooms, missing };
}

export function isGuestReservation(summary) {
    return !/not available/i.test(summary || '');
}

// Owner corrections, hand-added bookings, and hidden rows must survive the next sync.
export function isProtected(row) {
    if (!row) return false;
    return row.source === 'manual' || row.pinned === true || row.suppressed === true;
}

export function planBookingWrite({ existing, incoming, successfulRooms }) {
    const existingById = new Map((existing || []).map(b => [b.id, b]));
    const incomingById = new Map((incoming || []).map(b => [b.id, b]));
    const upserts = [];
    for (const booking of incoming || []) {
        const prev = existingById.get(booking.id);
        if (prev && isProtected(prev)) continue;
        upserts.push(booking);
    }
    const staleIds = (existing || [])
        .filter(b => successfulRooms.has(b.room) && !isProtected(b) && !incomingById.has(b.id))
        .map(b => b.id);
    return { upserts, staleIds };
}

export function imminentChanges({ existing, incoming, todayStr, tomorrowStr }) {
    const existingById = new Map((existing || []).map(b => [b.id, b]));
    const incomingById = new Map((incoming || []).map(b => [b.id, b]));
    const soon = (checkin) => checkin === todayStr || checkin === tomorrowStr;
    const changes = [];
    for (const booking of incoming || []) {
        if (!soon(booking.checkin)) continue;
        const prev = existingById.get(booking.id);
        if (prev && isProtected(prev)) continue;
        if (!prev) changes.push({ type: 'new', booking });
        else if (prev.checkin !== booking.checkin || prev.checkout !== booking.checkout) {
            changes.push({ type: 'modified', booking, previous: prev });
        }
    }
    for (const booking of existing || []) {
        if (!soon(booking.checkin) || isProtected(booking)) continue;
        if (!incomingById.has(booking.id)) changes.push({ type: 'cancelled', booking });
    }
    return changes;
}

function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function parseDate(s) {
    return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
}

function fmtDate(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    return `${days[dt.getUTCDay()]} ${d} ${MONTH_NAMES[m - 1]} ${y}`;
}

export function parseIcal(text) {
    // Unfold RFC 5545 line continuations (line ending + whitespace = one logical line)
    const unfolded = text.replace(/\r\n[ \t]/g, '').replace(/\r[ \t]/g, '').replace(/\n[ \t]/g, '');
    const events = [];
    const lines  = unfolded.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    let current  = null;
    for (const raw of lines) {
        const line = raw.trimEnd();
        if (line === 'BEGIN:VEVENT') { current = {}; continue; }
        if (line === 'END:VEVENT') {
            if (current?.uid && current?.dtstart && current?.dtend) events.push(current);
            current = null; continue;
        }
        if (!current) continue;
        if (line.startsWith('UID:'))     current.uid     = line.slice(4).trim();
        if (line.startsWith('SUMMARY:')) current.summary = line.slice(8).trim();
        const dsm = line.match(/^DTSTART[^:]*:(\d{8})/);
        const dem = line.match(/^DTEND[^:]*:(\d{8})/);
        if (dsm) current.dtstart = dsm[1];
        if (dem) current.dtend   = dem[1];
    }
    return events.map(e => ({
        uid:      e.uid,
        summary:  e.summary || '',
        checkin:  parseDate(e.dtstart),
        checkout: parseDate(e.dtend),
    }));
}

function buildAlertEmail(changes, todayStr, tomorrowStr) {
    const rows = changes.map(c => {
        const b = c.booking;
        const when = b.checkin === todayStr ? 'TODAY' : 'TOMORROW';
        let badge, sentence;
        if (c.type === 'new') {
            badge = `<span style="background:#27AE60;color:#fff;padding:3px 10px;border-radius:6px;font-size:0.75rem;font-weight:700">NEW BOOKING</span>`;
            sentence = `A new guest has been booked in — checking in <strong>${when} (${fmtDate(b.checkin)})</strong>, checking out <strong>${fmtDate(b.checkout)}</strong>.`;
        } else if (c.type === 'cancelled') {
            badge = `<span style="background:#C0392B;color:#fff;padding:3px 10px;border-radius:6px;font-size:0.75rem;font-weight:700">CANCELLED</span>`;
            sentence = `This booking has been <strong>cancelled</strong>. The guest was due to check in <strong>${when} (${fmtDate(b.checkin)})</strong> and check out <strong>${fmtDate(b.checkout)}</strong>.`;
        } else {
            badge = `<span style="background:#E67E22;color:#fff;padding:3px 10px;border-radius:6px;font-size:0.75rem;font-weight:700">DATES CHANGED</span>`;
            sentence = `The dates have changed. It <strong>was</strong> check-in ${fmtDate(c.previous.checkin)} → check-out ${fmtDate(c.previous.checkout)}. It is <strong>now</strong> check-in ${fmtDate(b.checkin)} → check-out ${fmtDate(b.checkout)}.`;
        }
        return `<div style="background:#fff5f5;border:1px solid #f5c6c6;border-radius:10px;padding:14px;margin-bottom:10px">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
                ${badge}
                <span style="font-weight:800;color:#C0392B;font-size:0.95rem">${escHtml(b.room)}</span>
            </div>
            <div style="font-size:0.9rem;color:#2C3E50;line-height:1.55">${sentence}</div>
        </div>`;
    }).join('');

    return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f4f7f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<div style="max-width:580px;margin:24px auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 2px 16px rgba(192,57,43,0.25);border:2px solid #E74C3C">
  <div style="background:linear-gradient(135deg,#C0392B,#E74C3C);padding:22px 28px">
    <div style="display:inline-block;background:rgba(255,255,255,0.25);color:#fff;padding:4px 12px;border-radius:100px;font-size:0.72rem;font-weight:800;letter-spacing:0.6px;margin-bottom:8px">🚨 ACTION NEEDED</div>
    <h2 style="margin:0;color:#fff;font-size:1.15rem;font-weight:800">Airbnb Check-in Changed — Within 24 Hours</h2>
    <p style="margin:4px 0 0;color:rgba(255,255,255,0.85);font-size:0.82rem">A guest arrival is changing very soon — please check now</p>
  </div>
  <div style="padding:24px 28px">
    <p style="color:#C0392B;font-weight:700;margin-top:0">A booking has changed for a guest arriving within the next 24 hours:</p>
    ${rows}
    <p style="margin-top:16px;text-align:center">
        <a href="https://angussullivan.github.io/cleaner-app/cleaner.html"
           style="display:inline-block;background:#C0392B;color:#fff;padding:13px 28px;border-radius:10px;text-decoration:none;font-weight:800;font-size:0.95rem">
           View Schedule Now →
        </a>
    </p>
    <p style="font-size:0.78rem;color:#999;text-align:center;margin:14px 0 0">Note: the app's own calendar can take up to an hour to catch up with this change.</p>
  </div>
  <div style="padding:14px 28px;background:#f9f9f9;border-top:1px solid #eee;font-size:0.72rem;color:#aaa;text-align:center">
    Sent automatically by Hours Tracker · <a href="https://angussullivan.github.io/cleaner-app/cleaner.html" style="color:#62B6CB">Open app</a>
  </div>
</div></body></html>`;
}

function sydneyToday() {
    const sydneyNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Australia/Sydney' }));
    const todayStr = `${sydneyNow.getFullYear()}-${String(sydneyNow.getMonth()+1).padStart(2,'0')}-${String(sydneyNow.getDate()).padStart(2,'0')}`;
    const tomorrow = new Date(sydneyNow);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth()+1).padStart(2,'0')}-${String(tomorrow.getDate()).padStart(2,'0')}`;
    const threeDaysOut = new Date(sydneyNow);
    threeDaysOut.setDate(threeDaysOut.getDate() + 3);
    const threeDaysStr = `${threeDaysOut.getFullYear()}-${String(threeDaysOut.getMonth()+1).padStart(2,'0')}-${String(threeDaysOut.getDate()).padStart(2,'0')}`;
    return { sydneyNow, todayStr, tomorrowStr, threeDaysStr };
}

async function main() {
    const { SUPABASE_URL, SUPABASE_SERVICE_KEY, GMAIL_USER, GMAIL_APP_PASSWORD } = process.env;
    const { rooms, missing: missingFeeds } = roomFeedsFromEnv(process.env);
    const missing = [
        ...(!SUPABASE_URL ? ['SUPABASE_URL'] : []),
        ...(!SUPABASE_SERVICE_KEY ? ['SUPABASE_SERVICE_KEY'] : []),
        ...missingFeeds,
    ];
    if (missing.length) {
        console.error(`Missing secret(s): ${missing.join(', ')}`);
        console.error('Add them under GitHub → Settings → Secrets and variables → Actions. Do not put feed URLs in the repo.');
        process.exit(1);
    }

    const { createClient } = await import('@supabase/supabase-js');
    const nodemailerMod = await import('nodemailer');
    const nodemailer = nodemailerMod.default || nodemailerMod;
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const { todayStr, tomorrowStr, threeDaysStr } = sydneyToday();

    const { data: existing, error: existingErr } = await supabase
        .from('airbnb_bookings')
        .select('*')
        .gte('checkout', todayStr);
    if (existingErr) throw new Error(`Could not read bookings: ${existingErr.message}`);
    const existingRows = existing || [];

    const allBookings = [];
    const successfulRooms = new Set();
    for (const room of rooms) {
        try {
            console.log(`Fetching ${room.name}...`);
            const controller = new AbortController();
            const fetchTimer = setTimeout(() => controller.abort(), 15000);
            let res;
            try {
                res = await fetch(room.url, { signal: controller.signal });
            } finally {
                clearTimeout(fetchTimer);
            }
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const text = await res.text();
            const events = parseIcal(text);
            const upcoming = events.filter(e => e.checkout >= todayStr && isGuestReservation(e.summary));
            const filtered = events.filter(e => e.checkout >= todayStr).length - upcoming.length;
            console.log(`  ${upcoming.length} reservation(s)${filtered ? ` (${filtered} system block(s) filtered)` : ''}`);
            for (const e of upcoming) {
                allBookings.push({
                    id:         `${room.name.replaceAll(' ','').toLowerCase()}-${e.uid}`,
                    room:       room.name,
                    checkin:    e.checkin,
                    checkout:   e.checkout,
                    summary:    e.summary,
                    fetched_at: new Date().toISOString(),
                });
            }
            successfulRooms.add(room.name);
        } catch (err) {
            // Do not log err.message — Node's fetch error text includes the request URL, and that URL is the secret.
            const reason = err.name === 'AbortError' ? 'timed out' : (err.message || '').startsWith('HTTP ') ? err.message : 'request failed';
            console.error(`  FAILED ${room.name}: ${reason}`);
        }
    }

    if (successfulRooms.size === 0) {
        throw new Error('All room iCal fetches failed — aborting to preserve Supabase data');
    }
    if (successfulRooms.size < rooms.length) {
        const failed = rooms.map(r => r.name).filter(n => !successfulRooms.has(n));
        console.warn(`Partial fetch — skipping stale cleanup for failed rooms: ${failed.join(', ')}`);
    }

    const imminent = allBookings.filter(b => b.checkin <= threeDaysStr || b.checkout <= threeDaysStr);
    if (imminent.length > 0) {
        console.log('Imminent events (next 3 days):');
        imminent.forEach(b => console.log(`  [${b.room}] checkin=${b.checkin} checkout=${b.checkout} summary="${b.summary?.slice(0,50)}"`));
    }

    const changes = imminentChanges({
        existing: existingRows,
        incoming: allBookings,
        todayStr,
        tomorrowStr,
    });

    const owners = parseEmailList(process.env.NOTIFY_OWNER_EMAILS);
    const cleaner = parseEmailList(process.env.NOTIFY_CLEANER_EMAIL);
    const alertTo = [...new Set([...owners, ...cleaner])];

    const transport = (GMAIL_USER && GMAIL_APP_PASSWORD)
        ? nodemailer.createTransport({ host: 'smtp.gmail.com', port: 587, secure: false, auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD } })
        : null;

    if (changes.length > 0) {
        console.log(`${changes.length} change(s) detected for imminent check-ins — sending alert`);
        if (!transport) {
            console.warn('  GMAIL credentials not set — skipping email');
        } else if (alertTo.length === 0) {
            console.warn('  NOTIFY_OWNER_EMAILS / NOTIFY_CLEANER_EMAIL not set — skipping email');
        } else {
            const hasCancellation = changes.some(c => c.type === 'cancelled');
            const subject = hasCancellation
                ? `🚨 URGENT: Airbnb booking CANCELLED — guest was arriving within 24h`
                : `🚨 URGENT: Airbnb check-in changed — action needed within 24h`;
            await transport.sendMail({
                from:    `"Hours Tracker" <${GMAIL_USER}>`,
                to:      alertTo.join(', '),
                subject,
                html:    buildAlertEmail(changes, todayStr, tomorrowStr),
            });
            console.log('  Alert email sent');
        }
    } else {
        console.log('No changes to imminent bookings');
    }

    const { error: delErr } = await supabase
        .from('airbnb_bookings')
        .delete()
        .lt('checkout', todayStr);
    if (delErr) console.warn('Delete old:', delErr.message);

    const { upserts, staleIds } = planBookingWrite({
        existing: existingRows,
        incoming: allBookings,
        successfulRooms,
    });
    const protectedCount = existingRows.filter(b => successfulRooms.has(b.room) && isProtected(b)).length;
    if (protectedCount > 0) console.log(`Leaving ${protectedCount} owner-protected booking(s) untouched`);

    if (staleIds.length > 0) {
        for (let i = 0; i < staleIds.length; i += 100) {
            const chunk = staleIds.slice(i, i + 100);
            const { error } = await supabase.from('airbnb_bookings').delete().in('id', chunk);
            if (error) console.warn(`Delete stale (batch ${Math.floor(i/100)+1}):`, error.message);
        }
        console.log(`Deleted ${staleIds.length} stale/cancelled booking(s)`);
    }

    if (upserts.length > 0) {
        // defaultToNull: false so omitted columns (pinned, source, suppressed) are not wiped.
        const { error } = await supabase
            .from('airbnb_bookings')
            .upsert(upserts, { onConflict: 'id', defaultToNull: false });
        if (error) throw new Error(`Upsert failed: ${error.message}`);
    }

    console.log(`Done — ${allBookings.length} feed booking(s), ${upserts.length} written, across ${successfulRooms.size}/${rooms.length} room(s)`);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
    main().catch(err => { console.error('Fatal:', err.message || err); process.exit(1); });
}
