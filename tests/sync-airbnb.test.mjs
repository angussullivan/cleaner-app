import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
    parseIcal,
    parseEmailList,
    roomFeedsFromEnv,
    isGuestReservation,
    isProtected,
    planBookingWrite,
    imminentChanges,
} from '../.github/scripts/sync-airbnb.js';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '../.github/scripts/sync-airbnb.js');

test('room feed secrets are required and URLs are not invented', () => {
    const { rooms, missing } = roomFeedsFromEnv({});
    assert.deepEqual(missing, ['AIRBNB_ICAL_ROOM_1', 'AIRBNB_ICAL_ROOM_2', 'AIRBNB_ICAL_ROOM_3']);
    assert.equal(rooms[0].url, '');
    const filled = roomFeedsFromEnv({
        AIRBNB_ICAL_ROOM_1: ' https://example.test/1.ics ',
        AIRBNB_ICAL_ROOM_2: 'https://example.test/2.ics',
        AIRBNB_ICAL_ROOM_3: 'https://example.test/3.ics',
    });
    assert.deepEqual(filled.missing, []);
    assert.equal(filled.rooms[0].url, 'https://example.test/1.ics');
    assert.equal(filled.rooms[0].name, 'Room 1');
});

test('running the script without feed secrets fails before any network call', () => {
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /AIRBNB_ICAL_ROOM_1/);
    assert.doesNotMatch(result.stderr + result.stdout, /airbnb\.com/i);
});

test('parseIcal unfolds lines and keeps dates', () => {
    const text = [
        'BEGIN:VCALENDAR',
        'BEGIN:VEVENT',
        'UID:abc-1',
        'SUMMARY:Reserved',
        'DTSTART;VALUE=DATE:20261121',
        'DTEND;VALUE=DATE:20261124',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:fold-1',
        'SUMMARY:Guest',
        '  continued',
        'DTSTART:20261201',
        'DTEND:20261203',
        'END:VEVENT',
        'END:VCALENDAR',
    ].join('\n');
    const events = parseIcal(text);
    assert.equal(events.length, 2);
    assert.deepEqual(events[0], { uid: 'abc-1', summary: 'Reserved', checkin: '2026-11-21', checkout: '2026-11-24' });
    assert.equal(events[1].summary, 'Guest continued');
    assert.equal(events[1].checkin, '2026-12-01');
});

test('system blocks are not guest reservations', () => {
    assert.equal(isGuestReservation('Airbnb (Not available)'), false);
    assert.equal(isGuestReservation('Reserved'), true);
});

test('owner overrides are not updated or deleted by the sync', () => {
    const existing = [
        { id: 'room1-a', room: 'Room 1', checkin: '2026-11-21', checkout: '2026-11-24', source: 'ical', pinned: false, suppressed: false },
        { id: 'room1-b', room: 'Room 1', checkin: '2026-11-22', checkout: '2026-11-25', source: 'ical', pinned: true, suppressed: false },
        { id: 'room2-c', room: 'Room 2', checkin: '2026-11-23', checkout: '2026-11-26', source: 'ical', pinned: false, suppressed: true },
        { id: 'manual-1', room: 'Room 3', checkin: '2026-11-28', checkout: '2026-11-30', source: 'manual', pinned: true, suppressed: false },
        { id: 'room1-gone', room: 'Room 1', checkin: '2026-12-01', checkout: '2026-12-04', source: 'ical', pinned: false, suppressed: false },
        { id: 'room2-stale-but-failed', room: 'Room 2', checkin: '2026-12-02', checkout: '2026-12-05', source: 'ical', pinned: false, suppressed: false },
    ];
    const incoming = [
        { id: 'room1-a', room: 'Room 1', checkin: '2026-11-21', checkout: '2026-11-27', summary: 'changed' },
        { id: 'room1-b', room: 'Room 1', checkin: '2026-11-22', checkout: '2026-11-29', summary: 'feed wants to clobber' },
        { id: 'room2-c', room: 'Room 2', checkin: '2026-11-23', checkout: '2026-11-26', summary: 'hidden guest' },
        { id: 'room1-new', room: 'Room 1', checkin: '2026-12-10', checkout: '2026-12-12', summary: 'new' },
    ];
    const { upserts, staleIds } = planBookingWrite({
        existing,
        incoming,
        successfulRooms: new Set(['Room 1']),
    });
    assert.deepEqual(upserts.map(b => b.id).sort(), ['room1-a', 'room1-new']);
    assert.deepEqual(staleIds, ['room1-gone']);
    assert.equal(isProtected(existing[1]), true);
    assert.equal(isProtected(existing[2]), true);
    assert.equal(isProtected(existing[3]), true);
});

test('24h alerts ignore protected rows and bookings outside today or tomorrow', () => {
    const existing = [
        { id: 'keep', room: 'Room 1', checkin: '2026-11-21', checkout: '2026-11-24', pinned: true, source: 'ical' },
        { id: 'cancel', room: 'Room 2', checkin: '2026-11-22', checkout: '2026-11-25', pinned: false, source: 'ical' },
        { id: 'manual', room: 'Room 3', checkin: '2026-11-21', checkout: '2026-11-23', source: 'manual', pinned: true },
    ];
    const incoming = [
        { id: 'keep', room: 'Room 1', checkin: '2026-11-21', checkout: '2026-11-30' },
        { id: 'later', room: 'Room 1', checkin: '2026-11-23', checkout: '2026-11-26' },
        { id: 'fresh', room: 'Room 2', checkin: '2026-11-22', checkout: '2026-11-24' },
    ];
    const changes = imminentChanges({ existing, incoming, todayStr: '2026-11-21', tomorrowStr: '2026-11-22' });
    assert.deepEqual(changes.map(c => `${c.type}:${c.booking.id}`).sort(), ['cancelled:cancel', 'new:fresh']);
});

test('email lists accept commas and semicolons and drop blanks', () => {
    assert.deepEqual(parseEmailList(' a@b.com, c@d.com ; e@f.com '), ['a@b.com', 'c@d.com', 'e@f.com']);
    assert.deepEqual(parseEmailList(''), []);
});
