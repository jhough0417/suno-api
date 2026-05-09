/**
 * AccountManager.ts
 * =================
 *
 * Server-side cookie acquisition for the Suno account pool.
 *
 * This is what makes the account pool sustainable: instead of needing the
 * admin to keep N Chrome profiles on a Mac and manually trigger refreshes,
 * the proxy itself maintains a pool of persistent Playwright profiles —
 * one per Suno account — on a Railway Volume mount. Each refresh is just
 * "open the persisted profile, navigate to suno.com, mint a fresh JWT,
 * extract cookies."
 *
 * Two operations:
 *
 *   onboardAccount({email, password, profileDirPath})
 *     → Fresh login. Used once per account at first setup. Launches a
 *       headless browser, navigates Suno's login flow, attempts Google
 *       OAuth with the provided credentials. On success, persists the
 *       Chrome profile under /data/suno-profiles/{profileDirPath}/ so
 *       subsequent refreshes don't need credentials. Returns the harvested
 *       cookies. On failure (Google challenge, captcha, etc.) returns the
 *       reason so admin can intervene.
 *
 *   refreshAccount({profileDirPath})
 *     → Silent JWT refresh. Used on a schedule (every ~6h) or on-demand.
 *       Reuses the persisted profile, navigates suno.com (auto-resumes
 *       session), mints fresh __session JWT via auth.suno.com. Returns
 *       updated cookies. If the persisted session is dead (e.g. __client
 *       expired), returns 'session_expired' so the caller can fall back to
 *       onboardAccount with stored credentials.
 *
 * Both operations are atomic and isolated per-account: launching one
 * profile doesn't affect any other account's profile.
 *
 * Architecture context: this is the "Option B" approach we discussed —
 * server-side workforce instead of N Chrome profiles per user's Mac.
 * It runs on Railway (outside GFW, can reach Suno) co-located with the
 * existing Suno proxy.
 */

import { chromium, BrowserContext, Page } from 'rebrowser-playwright-core';
import { promises as fs } from 'fs';
import path from 'node:path';
import pino from 'pino';

const logger = pino();

// Where Chrome profiles persist on the Railway Volume. Set this volume mount
// path in the Railway service settings (e.g. /data) and we'll create one
// subdirectory per account beneath it.
const PROFILE_BASE = process.env.SUNO_PROFILE_BASE || '/data/suno-profiles';

// Total time budget for a fresh login (Google OAuth can be slow).
const ONBOARD_TIMEOUT_MS = 90_000;
// Total time budget for a silent refresh (just JWT mint).
const REFRESH_TIMEOUT_MS = 30_000;

// Disable the GPU/sandbox flags that don't make sense in containers.
const CHROMIUM_LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-blink-features=AutomationControlled',
];

// ───────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────

export type LoginStatus =
  | 'success'
  | 'session_expired'         // refresh path: persisted session dead, need re-login
  | 'invalid_credentials'     // login path: Suno/Google said no
  | 'needs_human_verification'// login path: Google challenged with 2FA / captcha / device check
  | 'captcha_failed'          // login path: captcha attempt didn't pass
  | 'rate_limited'            // login path: too many login attempts from our IP
  | 'network_error'           // any path: couldn't reach suno.com or auth.suno.com
  | 'unknown_error';

export interface OnboardResult {
  status: LoginStatus;
  cookieString?: string;            // present iff status === 'success'
  jwtExpiresAt?: number;            // epoch seconds
  error?: string;                   // human-readable error detail
  screenshot?: string;              // data URL, present for 'needs_human_verification'
  durationMs: number;
}

export interface RefreshResult {
  status: LoginStatus;
  cookieString?: string;
  jwtExpiresAt?: number;
  error?: string;
  durationMs: number;
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

async function ensureProfileDir(profileDirPath: string): Promise<string> {
  const full = path.join(PROFILE_BASE, profileDirPath);
  await fs.mkdir(full, { recursive: true });
  return full;
}

function parseJwtExp(jwt: string): number | undefined {
  const parts = jwt.split('.');
  if (parts.length < 2) return undefined;
  try {
    const payloadB64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payloadB64 + '='.repeat((4 - (payloadB64.length % 4)) % 4);
    const json = Buffer.from(padded, 'base64').toString('utf8');
    const claims = JSON.parse(json);
    return typeof claims.exp === 'number' ? claims.exp : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build the Cookie-header-style string from the browser's cookies.
 * Same format the existing SUNO_COOKIE env var uses, so the proxy code
 * doesn't need to change downstream.
 */
async function buildCookieString(context: BrowserContext): Promise<string> {
  const cookies = await context.cookies(['https://suno.com', 'https://auth.suno.com']);
  // Order matters for some legacy parsers; put the auth-relevant ones first.
  const priority = [
    '__client',
    '__client_Jnxw-muT',
    '__client_uat',
    '__client_uat_Jnxw-muT',
    '__session',
    '__session_Jnxw-muT',
  ];
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const name of priority) {
    const c = cookies.find((x) => x.name === name);
    if (c) {
      parts.push(`${c.name}=${c.value}`);
      seen.add(name);
    }
  }
  for (const c of cookies) {
    if (!seen.has(c.name)) parts.push(`${c.name}=${c.value}`);
  }
  return parts.join('; ');
}

// ───────────────────────────────────────────────────────────────────────────
// Refresh: silent JWT mint using persisted profile
// ───────────────────────────────────────────────────────────────────────────

export async function refreshAccount(opts: {
  profileDirPath: string;
}): Promise<RefreshResult> {
  const start = Date.now();
  const profileDir = await ensureProfileDir(opts.profileDirPath);
  let context: BrowserContext | null = null;

  try {
    context = await chromium.launchPersistentContext(profileDir, {
      headless: true,
      args: CHROMIUM_LAUNCH_ARGS,
      timeout: REFRESH_TIMEOUT_MS,
    });
    const page = await context.newPage();

    // Navigate to suno.com and let the SDK auto-resume.
    await page.goto('https://suno.com/', {
      waitUntil: 'domcontentloaded',
      timeout: REFRESH_TIMEOUT_MS,
    });

    // Wait for the auth handshake to finish — Suno's SDK will fetch a
    // fresh __session token from auth.suno.com on page load if the
    // existing one is stale. We give it a generous window.
    await page.waitForTimeout(4000);

    // Probe authentication state by looking for an __client cookie.
    // If it's missing, the persisted session is dead.
    const cookies = await context.cookies(['https://suno.com', 'https://auth.suno.com']);
    const hasClient = cookies.some((c) => c.name === '__client' && c.value.length > 50);
    if (!hasClient) {
      logger.warn('refreshAccount: no __client cookie after page load; session expired');
      return {
        status: 'session_expired',
        error: 'No __client cookie found after suno.com load — persisted session is dead.',
        durationMs: Date.now() - start,
      };
    }

    // Try to read user state — if Suno returns 401 here, the session is
    // technically present but invalidated server-side.
    let stateOk = false;
    try {
      const probe = await page.evaluate(async () => {
        const r = await fetch('/api/get_user_state/', { credentials: 'include' });
        return { status: r.status };
      });
      stateOk = probe.status === 200;
    } catch {
      // Probe failed — non-fatal, we still have cookies.
      stateOk = true;
    }
    if (!stateOk) {
      logger.warn('refreshAccount: /api/get_user_state returned non-200');
      return {
        status: 'session_expired',
        error: 'suno.com returned 401 on user-state probe.',
        durationMs: Date.now() - start,
      };
    }

    const cookieString = await buildCookieString(context);
    const sessionMatch = cookieString.match(/__session=([^;]+)/);
    const jwtExp = sessionMatch ? parseJwtExp(sessionMatch[1]) : undefined;

    return {
      status: 'success',
      cookieString,
      jwtExpiresAt: jwtExp,
      durationMs: Date.now() - start,
    };
  } catch (err: any) {
    logger.error({ err: err?.message }, 'refreshAccount failed');
    return {
      status: err?.message?.includes('Timeout') ? 'network_error' : 'unknown_error',
      error: err?.message || String(err),
      durationMs: Date.now() - start,
    };
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Onboard: fresh login (Google OAuth) into a new persisted profile
// ───────────────────────────────────────────────────────────────────────────

/**
 * Detect whether a Google challenge page is asking us for something we
 * can't handle (2FA code, "is this you?" device verification, captcha).
 * Returns the challenge name if found, else null.
 */
async function detectGoogleChallenge(page: Page): Promise<string | null> {
  // Look for known challenge indicators. These are best-effort heuristics —
  // Google rotates UI frequently.
  const url = page.url();
  if (/challenge\/(pwd|recaptcha|az|kpe|ipp|ootp|sms)/i.test(url)) {
    const match = url.match(/challenge\/([a-z]+)/i);
    return match ? match[1] : 'unknown';
  }
  if (/v3\/signin\/challenge/i.test(url)) return 'identifier_challenge';
  if (/accounts\.google\.com\/v3\/signin\/identifier\/_\/InfoCard/i.test(url)) return 'info_card';

  const body = await page.content().catch(() => '');
  if (/Verify it.{0,3}s you/i.test(body)) return 'identity_verification';
  if (/2-Step Verification/i.test(body)) return 'two_step';
  if (/Get a verification code/i.test(body)) return 'sms_code';
  if (/Confirm your recovery email/i.test(body)) return 'recovery_email';
  return null;
}

export async function onboardAccount(opts: {
  email: string;
  password: string;
  profileDirPath: string;
  captureScreenshot?: boolean;
}): Promise<OnboardResult> {
  const start = Date.now();
  const profileDir = await ensureProfileDir(opts.profileDirPath);
  let context: BrowserContext | null = null;
  let page: Page | null = null;

  const captureScreenshot = async (): Promise<string | undefined> => {
    if (!opts.captureScreenshot || !page) return undefined;
    try {
      const buf = await page.screenshot({ type: 'png', fullPage: false });
      return `data:image/png;base64,${buf.toString('base64')}`;
    } catch {
      return undefined;
    }
  };

  try {
    context = await chromium.launchPersistentContext(profileDir, {
      headless: true,
      args: CHROMIUM_LAUNCH_ARGS,
      viewport: { width: 1280, height: 800 },
      timeout: ONBOARD_TIMEOUT_MS,
    });
    page = await context.newPage();

    // ── Step 1: navigate to Suno's sign-in page ─────────────────────────
    await page.goto('https://suno.com/', {
      waitUntil: 'domcontentloaded',
      timeout: ONBOARD_TIMEOUT_MS,
    });

    // If we already have a session (re-onboard of the same profile), bail
    // out early with success.
    {
      const existing = await context.cookies(['https://suno.com']);
      if (existing.some((c) => c.name === '__client' && c.value.length > 50)) {
        logger.info('onboardAccount: profile already authenticated; skipping login');
        const cookieString = await buildCookieString(context);
        const m = cookieString.match(/__session=([^;]+)/);
        return {
          status: 'success',
          cookieString,
          jwtExpiresAt: m ? parseJwtExp(m[1]) : undefined,
          durationMs: Date.now() - start,
        };
      }
    }

    // Click "Sign in" — Suno's button text varies; try several selectors.
    const signinSelectors = [
      'a:has-text("Sign in")',
      'button:has-text("Sign in")',
      'a[href*="sign-in"]',
      'a:has-text("登录")',
      'button:has-text("登录")',
    ];
    let clickedSignin = false;
    for (const sel of signinSelectors) {
      try {
        await page.click(sel, { timeout: 4000 });
        clickedSignin = true;
        break;
      } catch {
        // try next
      }
    }
    if (!clickedSignin) {
      // Maybe Suno auto-redirected us to /sign-in already.
      if (!page.url().includes('sign-in')) {
        await page.goto('https://suno.com/sign-in', {
          waitUntil: 'domcontentloaded',
          timeout: 15_000,
        });
      }
    }

    // ── Step 2: Click "Continue with Google" ────────────────────────────
    const googleBtnSelectors = [
      'button:has-text("Continue with Google")',
      'button:has-text("Sign in with Google")',
      'button:has-text("Google")',
      '[data-provider="google"]',
    ];
    let clickedGoogle = false;
    for (const sel of googleBtnSelectors) {
      try {
        await page.click(sel, { timeout: 6000 });
        clickedGoogle = true;
        break;
      } catch {
        // try next
      }
    }
    if (!clickedGoogle) {
      logger.error('onboardAccount: could not find "Continue with Google" button');
      return {
        status: 'unknown_error',
        error: 'Could not find Google sign-in button on Suno page.',
        screenshot: await captureScreenshot(),
        durationMs: Date.now() - start,
      };
    }

    // Wait for the Google OAuth popup or redirect.
    await page.waitForTimeout(2500);

    // Google may have opened a popup or redirected the main frame; handle both.
    let oauthPage: Page = page;
    const pages = context.pages();
    const googlePage = pages.find((p) => p.url().includes('accounts.google.com'));
    if (googlePage && googlePage !== page) {
      oauthPage = googlePage;
    }

    // ── Step 3: Type the email ──────────────────────────────────────────
    try {
      await oauthPage.waitForSelector('input[type="email"], input#identifierId', {
        timeout: 12_000,
      });
      await oauthPage.fill('input[type="email"], input#identifierId', opts.email);
      // Click Next.
      await oauthPage.click('#identifierNext button, button:has-text("Next")', {
        timeout: 5000,
      });
    } catch (err: any) {
      logger.error({ err: err?.message }, 'onboardAccount: email step failed');
      return {
        status: 'unknown_error',
        error: 'Could not fill Google email field: ' + (err?.message || ''),
        screenshot: await captureScreenshot(),
        durationMs: Date.now() - start,
      };
    }

    // Wait for either password field, captcha, or challenge.
    await oauthPage.waitForTimeout(2500);

    // ── Step 4: Check for any pre-password challenges ──────────────────
    const earlyChallenge = await detectGoogleChallenge(oauthPage);
    if (earlyChallenge && earlyChallenge !== 'identifier_challenge') {
      logger.warn(
        { challenge: earlyChallenge, url: oauthPage.url() },
        'onboardAccount: Google challenged before password step'
      );
      return {
        status: 'needs_human_verification',
        error: `Google challenge: ${earlyChallenge}`,
        screenshot: await captureScreenshot(),
        durationMs: Date.now() - start,
      };
    }

    // ── Step 5: Type the password ──────────────────────────────────────
    try {
      await oauthPage.waitForSelector('input[autocomplete="current-password"]:not([aria-hidden="true"]), input[type="password"]:not([aria-hidden="true"]):not([name="hiddenPassword"])', {
        timeout: 15_000,
        state: "visible",
      });
      await oauthPage.fill(
        'input[autocomplete="current-password"]:not([aria-hidden="true"]), input[type="password"]:not([aria-hidden="true"]):not([name="hiddenPassword"])',
        opts.password
      );
      await oauthPage.click('#passwordNext button, button:has-text("Next")', { timeout: 5000 });
    } catch (err: any) {
      // No password field → maybe Google jumped straight to a challenge.
      const ch = await detectGoogleChallenge(oauthPage);
      if (ch) {
        return {
          status: 'needs_human_verification',
          error: `Google challenge before password: ${ch}`,
          screenshot: await captureScreenshot(),
          durationMs: Date.now() - start,
        };
      }
      return {
        status: 'unknown_error',
        error: 'Could not fill Google password field: ' + (err?.message || ''),
        screenshot: await captureScreenshot(),
        durationMs: Date.now() - start,
      };
    }

    // ── Step 6: Wait for redirect back to Suno ────────────────────────
    // Two acceptable end states: oauthPage navigates back to suno.com, OR
    // the original `page` does (popup auth flow closes and main page
    // refreshes).
    try {
      await Promise.race([
        oauthPage.waitForURL(/suno\.com/, { timeout: 30_000 }).catch(() => null),
        page.waitForURL(/suno\.com/, { timeout: 30_000 }).catch(() => null),
        page.waitForFunction(
          () => document.cookie.includes('__client='),
          { timeout: 30_000 }
        ).catch(() => null),
      ]);
    } catch {
      // fall through and check below
    }

    // Let cookies settle.
    await page.waitForTimeout(3000);

    // ── Step 7: Check for password-time challenge (2FA, captcha) ──────
    const lateChallenge = await detectGoogleChallenge(oauthPage);
    if (lateChallenge) {
      return {
        status: 'needs_human_verification',
        error: `Google post-password challenge: ${lateChallenge}`,
        screenshot: await captureScreenshot(),
        durationMs: Date.now() - start,
      };
    }

    // ── Step 8: Verify we actually got authenticated ──────────────────
    const finalCookies = await context.cookies(['https://suno.com', 'https://auth.suno.com']);
    const hasClient = finalCookies.some((c) => c.name === '__client' && c.value.length > 50);
    if (!hasClient) {
      logger.error('onboardAccount: no __client cookie after login flow');
      return {
        status: 'unknown_error',
        error: 'Login flow completed but no __client cookie was set.',
        screenshot: await captureScreenshot(),
        durationMs: Date.now() - start,
      };
    }

    // Force a final navigation to suno.com to trigger __session minting.
    await page.goto('https://suno.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 20_000,
    });
    await page.waitForTimeout(2500);

    const cookieString = await buildCookieString(context);
    const sessionMatch = cookieString.match(/__session=([^;]+)/);
    const jwtExp = sessionMatch ? parseJwtExp(sessionMatch[1]) : undefined;

    logger.info(
      { durationMs: Date.now() - start },
      'onboardAccount: login successful'
    );
    return {
      status: 'success',
      cookieString,
      jwtExpiresAt: jwtExp,
      durationMs: Date.now() - start,
    };
  } catch (err: any) {
    logger.error({ err: err?.message }, 'onboardAccount: unexpected failure');
    return {
      status: 'unknown_error',
      error: err?.message || String(err),
      screenshot: await captureScreenshot(),
      durationMs: Date.now() - start,
    };
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
  }
}
