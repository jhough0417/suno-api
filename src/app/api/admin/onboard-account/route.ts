/**
 * /api/admin/onboard-account
 * ==========================
 *
 * POST — first-time login for a Suno account using stored credentials.
 *
 * Called by the admin app's POST /api/admin/suno-accounts/:id/onboard
 * after the user has provided email + password through the admin UI.
 *
 * Body (JSON):
 *   {
 *     accountId: "uuid-of-row-in-suno_accounts-table",
 *     email: "decrypted-email-string",
 *     password: "decrypted-password-string",
 *     profileDirPath: "uuid-of-row"  // suggested: same as accountId
 *   }
 *
 * Auth: X-Vault-Token header must match SUNO_RECONNECT_KEY env.
 *
 * Behaviour:
 *   - Launches Playwright in a fresh persisted profile directory at
 *     /data/suno-profiles/{profileDirPath}/
 *   - Drives the Suno → "Continue with Google" → email → password flow
 *   - On success: returns the harvested cookieString + jwtExpiresAt
 *   - On Google challenge: returns {status: 'needs_human_verification', screenshot: '...'}
 *   - On other failure: returns {status: '...', error: '...'}
 *
 * NEVER logs the password.
 */

import { NextRequest, NextResponse } from 'next/server';
import { onboardAccount } from '@/lib/AccountManager';
import { corsHeaders } from '@/lib/utils';

export const dynamic = 'force-dynamic';
// Long timeout: Google OAuth can be slow.
export const maxDuration = 120;

const RECONNECT_KEY = process.env.SUNO_RECONNECT_KEY || 'lsq-music-studio';

export async function POST(req: NextRequest) {
  // Auth gate.
  const auth = req.headers.get('x-vault-token') || '';
  if (auth !== RECONNECT_KEY) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: corsHeaders });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400, headers: corsHeaders });
  }

  const { accountId, email, password, profileDirPath, captureScreenshot } = body || {};
  if (!accountId || typeof accountId !== 'string') {
    return NextResponse.json({ error: 'accountId required' }, { status: 400, headers: corsHeaders });
  }
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return NextResponse.json({ error: 'valid email required' }, { status: 400, headers: corsHeaders });
  }
  if (!password || typeof password !== 'string' || password.length < 4) {
    return NextResponse.json({ error: 'valid password required' }, { status: 400, headers: corsHeaders });
  }
  const profileDir = profileDirPath || accountId;
  if (!/^[a-zA-Z0-9_\-]{1,100}$/.test(profileDir)) {
    return NextResponse.json(
      { error: 'profileDirPath must be 1-100 chars, alphanumeric/underscore/hyphen' },
      { status: 400, headers: corsHeaders }
    );
  }

  // Run the onboarding. AccountManager NEVER logs the password and discards
  // it from memory after the login completes.
  const result = await onboardAccount({
    email,
    password,
    profileDirPath: profileDir,
    captureScreenshot: !!captureScreenshot,
  });

  // Translate to a response shape that matches the admin app's expectations.
  // Note we deliberately omit the cookie content from the success response
  // body except when explicitly asked — the admin app immediately POSTs it
  // back to its own /store-cookie endpoint over HTTPS.
  const status =
    result.status === 'success' ? 200 :
    result.status === 'needs_human_verification' ? 202 :
    result.status === 'invalid_credentials' ? 401 :
    result.status === 'rate_limited' ? 429 :
    result.status === 'network_error' ? 503 :
    500;

  return NextResponse.json(result, { status, headers: corsHeaders });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 200, headers: corsHeaders });
}
