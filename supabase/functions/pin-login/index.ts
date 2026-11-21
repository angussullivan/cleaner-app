// PIN login for the 67 Res cleaner app.
//
// The anon/publishable key is public (it ships in cleaner.html). This function
// is the only way to turn a PIN into a Supabase session. Deploy with JWT
// verification OFF (`supabase functions deploy pin-login --no-verify-jwt`),
// or the gateway rejects the publishable key before this code runs.
//
// Secrets (Dashboard → Edge Functions → Secrets), matching two Auth users:
//   APP_CLEANER_EMAIL, APP_CLEANER_PASSWORD
//   APP_OWNER_EMAIL, APP_OWNER_PASSWORD
// PIN hashes live in cleaner_private.pin_credentials and are checked by cleaner_verify_pin.
// This function is new. Do not redeploy the Reservoir Stays photo functions.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...cors, 'Content-Type': 'application/json' },
    });
}

function clientIp(req: Request): string {
    const raw = req.headers.get('x-forwarded-for')
        || req.headers.get('cf-connecting-ip')
        || req.headers.get('x-real-ip')
        || 'unknown';
    return raw.split(',')[0].trim().slice(0, 64) || 'unknown';
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
    if (req.method !== 'POST') return json({ message: 'POST a PIN.' }, 405);

    const url = Deno.env.get('SUPABASE_URL') || '';
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
    if (!url || !anonKey || !serviceKey) {
        console.error('pin-login missing injected Supabase env');
        return json({ message: 'Login is not configured yet.' }, 500);
    }

    let pin = '';
    try {
        const body = await req.json();
        pin = String(body?.pin ?? '').trim();
    } catch {
        pin = '';
    }

    const admin = createClient(url, serviceKey, {
        auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: role, error: verifyError } = await admin.rpc('cleaner_verify_pin', {
        candidate: pin,
        client_ip: clientIp(req),
    });
    if (verifyError) {
        console.error('cleaner_verify_pin failed:', verifyError.message);
        return json({ message: 'Login is not configured yet.' }, 500);
    }
    if (role === 'locked') {
        return json({ error: 'locked', message: 'Too many tries. Wait 15 minutes and try again.' }, 429);
    }
    if (role !== 'cleaner' && role !== 'owner') {
        return json({ message: 'Incorrect PIN — try again' }, 401);
    }

    const email = Deno.env.get(role === 'owner' ? 'APP_OWNER_EMAIL' : 'APP_CLEANER_EMAIL') || '';
    const password = Deno.env.get(role === 'owner' ? 'APP_OWNER_PASSWORD' : 'APP_CLEANER_PASSWORD') || '';
    if (!email || !password) {
        console.error(`pin-login missing auth secret for role ${role}`);
        return json({ message: 'Login is not configured yet.' }, 500);
    }

    const auth = createClient(url, anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await auth.auth.signInWithPassword({
        email: email.trim(),
        password,
    });
    if (error || !data.session) {
        console.error(`sign-in failed for role ${role}:`, error?.message || 'no session');
        return json({ message: 'Login is not configured yet.' }, 500);
    }

    console.log(`pin-login ok role=${role}`);
    return json({
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_in: data.session.expires_in,
        role,
    });
});
