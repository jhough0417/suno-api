/**
 * /api/admin/refresh-account
 * ==========================
 *
 * POST — silent JWT refresh for an existing onboarded account.
 *
 * Used in two scenarios:
 *   1. Scheduled cron (every ~6h) iterates pool, refreshes each account
 *   2. Admin clicks "Refresh" in the UI for one specific account
 *
 * Body (JSON):
 *   {
 *     accountId: "uuid",
 *     profileDirPath: "uuid"  // path to the persisted Chrome profile
 *   }
 *
 * Auth: X-Vault-Token header.
 *
 * Behaviour:
 *   - Reuses the persisted profile at /data/suno-profiles/{profileDirPath}/
 *   - Visits suno.com — Suno's SDK refreshes __session JWT automatically
 *   - Reads cookies, returns them
 *
 *   - If the persisted session is dead (e.g. __client expired), returns
 *     {status: 'session_expired'} so the admin app knows to fall through
 *     to /onboard-account with the stored credentials.
 */

import { NextRequest, NextResponse } from 'next/server';
import { refreshAccount } from '@/lib/AccountManager';
import { corsHeaders } from '@/lib/utils';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const RECONNECT_KEY = process.env.SUNO_RECONNECT_KEY || 'lsq-music-studio';

export async function POST(req: NextRequest) {
  const auth = req.headers.get('x-vault-token') || '';
  if (auth !== RECONNECT_KEY) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: corsHeaders });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400, headers: corsHeaders });
  }

  const { accountId, profileDirPath } = body || {};
  if (!accountId || typeof accountId !== 'string') {
    return NextResponse.json({ error: 'accountId required' }, { status: 400, headers: corsHeaders });
  }
  const profileDir = profileDirPath || accountId;
  if (!/^[a-zA-Z0-9_\-]{1,100}$/.test(profileDir)) {
    return NextResponse.json(
      { error: 'profileDirPath must be 1-100 chars, alphanumeric/underscore/hyphen' },
      { status: 400, headers: corsHeaders }
    );
  }

  const result = await refreshAccount({ profileDirPath: profileDir });

  const status =
    result.status === 'success' ? 200 :
    result.status === 'session_expired' ? 410 :  // "Gone" — caller should re-onboard
    result.status === 'network_error' ? 503 :
    500;

  return NextResponse.json(result, { status, headers: corsHeaders });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 200, headers: corsHeaders });
}
