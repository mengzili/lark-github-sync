/**
 * Cloudflare Worker — OAuth proxy for feishu-github-sync setup page.
 *
 * Routes:
 *   GET  /auth/github       — Start GitHub OAuth (redirect to GitHub)
 *   GET  /callback/github   — Exchange code for token, redirect to setup page
 *   POST /api/verify-lark   — Proxy Lark credential verification (no CORS on Lark API)
 *
 * Environment bindings:
 *   GITHUB_CLIENT_ID      — GitHub OAuth App client ID (public)
 *   GITHUB_CLIENT_SECRET   — GitHub OAuth App client secret (wrangler secret)
 *   ALLOWED_ORIGIN         — e.g. https://zilimeng.com
 */

export interface Env {
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  ALLOWED_ORIGIN: string;
}

const SCOPES = 'repo workflow admin:org';

function cors(env: Env): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function getCookie(req: Request, name: string): string | null {
  const header = req.headers.get('Cookie') || '';
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(env) });
    }

    try {
      if (url.pathname === '/auth/github') return authGitHub(url, env);
      if (url.pathname === '/callback/github') return await callbackGitHub(req, url, env);
      if (url.pathname === '/api/verify-lark' && req.method === 'POST')
        return await verifyLark(req, env);
      return new Response('Not found', { status: 404 });
    } catch (err) {
      return new Response(`Internal error: ${err}`, { status: 500 });
    }
  },
};

// ---------------------------------------------------------------------------
// GET /auth/github?state=RANDOM
// Sets CSRF cookie, redirects to GitHub authorize URL.
// ---------------------------------------------------------------------------
function authGitHub(url: URL, env: Env): Response {
  const state = url.searchParams.get('state');
  if (!state) return new Response('Missing state', { status: 400 });

  const ghUrl = new URL('https://github.com/login/oauth/authorize');
  ghUrl.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  ghUrl.searchParams.set('scope', SCOPES);
  ghUrl.searchParams.set('state', state);
  ghUrl.searchParams.set('redirect_uri', `${url.origin}/callback/github`);

  return new Response(null, {
    status: 302,
    headers: new Headers([
      ['Location', ghUrl.toString()],
      ['Set-Cookie', `oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`],
    ]),
  });
}

// ---------------------------------------------------------------------------
// GET /callback/github?code=CODE&state=STATE
// Verifies CSRF, exchanges code for token, redirects to callback.html#token=...
// ---------------------------------------------------------------------------
async function callbackGitHub(req: Request, url: URL, env: Env): Promise<Response> {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return new Response('Missing code or state', { status: 400 });

  // CSRF check
  const cookieState = getCookie(req, 'oauth_state');
  if (cookieState !== state) {
    return new Response('State mismatch — possible CSRF. Please try again.', { status: 403 });
  }

  // Exchange code for token
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
    }),
  });

  const data = (await tokenRes.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!data.access_token) {
    return new Response(
      `GitHub OAuth failed: ${data.error_description || data.error || 'unknown'}`,
      { status: 502 },
    );
  }

  // Redirect to callback.html with token in fragment (never sent to server)
  const callbackPage = `${env.ALLOWED_ORIGIN}/lark-github-sync/callback.html`;

  return new Response(null, {
    status: 302,
    headers: new Headers([
      ['Location', `${callbackPage}#token=${data.access_token}`],
      // Clear the CSRF cookie
      ['Set-Cookie', 'oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0'],
    ]),
  });
}

// ---------------------------------------------------------------------------
// POST /api/verify-lark  {app_id, app_secret, domain}
// Proxies to Lark API to verify credentials (Lark has no CORS).
// ---------------------------------------------------------------------------
async function verifyLark(req: Request, env: Env): Promise<Response> {
  const origin = req.headers.get('Origin') || '';
  if (!origin.startsWith(env.ALLOWED_ORIGIN)) {
    return new Response('Forbidden', { status: 403 });
  }

  const body = (await req.json()) as { app_id?: string; app_secret?: string; domain?: string };
  if (!body.app_id || !body.app_secret) {
    return json({ valid: false, error: 'Missing app_id or app_secret' }, 400, env);
  }

  const base =
    body.domain === 'lark'
      ? 'https://open.larksuite.com'
      : 'https://open.feishu.cn';

  const res = await fetch(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: body.app_id, app_secret: body.app_secret }),
  });

  const data = (await res.json()) as { code?: number; msg?: string; tenant_access_token?: string };

  if (data.code === 0 && data.tenant_access_token) {
    return json({ valid: true }, 200, env);
  }
  return json({ valid: false, error: data.msg || 'Invalid credentials' }, 200, env);
}

function json(data: unknown, status: number, env: Env): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors(env) },
  });
}
