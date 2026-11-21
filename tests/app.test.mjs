import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(root, 'cleaner.html'), 'utf8');
const script = html.slice(html.lastIndexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));

function extractFunction(name) {
    const start = script.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`missing function ${name}`);
    let i = script.indexOf('{', start);
    let depth = 0;
    for (; i < script.length; i++) {
        if (script[i] === '{') depth++;
        else if (script[i] === '}') {
            depth--;
            if (depth === 0) return script.slice(start, i + 1);
        }
    }
    throw new Error(`unclosed function ${name}`);
}

test('the app script parses', () => {
    new Function(script);
});

test('plan dates follow a calendar, not the machine timezone', () => {
    const fns = new Function(`${extractFunction('addCalendarDays')}\n${extractFunction('weekdayIndex')}\n${extractFunction('getMondayStr')}\nreturn { addCalendarDays, weekdayIndex, getMondayStr };`)();
    assert.equal(fns.addCalendarDays('2026-11-21', 0), '2026-11-21');
    assert.equal(fns.addCalendarDays('2026-11-21', 14), '2026-12-05');
    assert.equal(fns.addCalendarDays('2026-01-31', 1), '2026-02-01');
    // 21 Nov 2026 is a Saturday. The Sydney week starts on the previous Monday.
    assert.equal(fns.weekdayIndex('2026-11-21'), 6);
    assert.equal(fns.getMondayStr('2026-11-21'), '2026-11-16');
    assert.equal(fns.getMondayStr('2026-11-22'), '2026-11-16'); // Sunday
    assert.equal(fns.getMondayStr('2026-11-16'), '2026-11-16');
});

test('the plan tab starts from Sydney today and always adds the checkout clean', () => {
    const plan = script.slice(script.indexOf('async function renderAirbnb'), script.indexOf('// LOG TAB'));
    assert.match(plan, /const tStr = todayStr\(\)/);
    assert.match(plan, /addCalendarDays\(tStr, i\)/);
    assert.doesNotMatch(plan, /const today = new Date\(\)/);
    assert.match(plan, /b\.id === `\$\{ds\}-auto` \|\| b\.id === ds/);
    assert.doesNotMatch(plan, /hasCheckout && !blocks\[ds\]/);
});

test('the repo no longer ships the PIN, feed URLs, or personal inboxes', () => {
    const bundled = [
        'cleaner.html',
        'README.md',
        'supabase-setup.sql',
        '.github/scripts/sync-airbnb.js',
        '.github/scripts/sync-calendar.js',
        '.github/scripts/send-emails.js',
        '.github/workflows/sync-airbnb.yml',
        '.github/workflows/sync-calendar.yml',
        '.github/workflows/scheduled-emails.yml',
    ].map(f => readFileSync(path.join(root, f), 'utf8')).join('\n');
    assert.doesNotMatch(bundled, /1234/);
    assert.doesNotMatch(bundled, /airbnb\.com/i);
    assert.doesNotMatch(bundled, /@(gmail|icloud)\.com/i);
    assert.doesNotMatch(bundled, /jennangusplan/);
    const server = [
        '.github/scripts/sync-airbnb.js',
        '.github/scripts/sync-calendar.js',
        '.github/scripts/send-emails.js',
    ].map(f => readFileSync(path.join(root, f), 'utf8')).join('\n');
    assert.doesNotMatch(server, /sb_publishable_/);
    assert.match(html, /const SUPABASE_ANON_KEY = '/);
});

test('low priority is allowed by the migration the owner runs first', () => {
    const sql = readFileSync(path.join(root, 'supabase/migrations/20261121090000_prepare_auth.sql'), 'utf8');
    assert.match(sql, /priority in \('low', 'normal', 'urgent'\)/);
    const lockdown = readFileSync(path.join(root, 'supabase/migrations/20261121100000_lockdown.sql'), 'utf8');
    assert.match(lockdown, /drop policy if exists "app_all"/);
    assert.match(lockdown, /set public = false/);
    assert.match(lockdown, /drop column if exists pin/);
});
