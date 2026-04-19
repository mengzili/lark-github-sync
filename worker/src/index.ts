/**
 * Cloudflare Worker — shared backend for lark-github-sync.
 *
 * Routes:
 *   GET  /auth/github           — Start GitHub OAuth (redirect to GitHub)
 *   GET  /callback/github       — Exchange code for token, redirect to setup page
 *   POST /api/verify-lark       — Proxy Lark credential verification (no CORS on Lark API)
 *   POST /api/register-tenant   — Register/update a GitHub org's tenant config in KV
 *   POST /webhook/github/:org   — Receive GitHub org webhook, dispatch to sync repo
 *
 * Environment:
 *   GITHUB_CLIENT_ID            — GitHub OAuth App client ID (public)
 *   GITHUB_CLIENT_SECRET        — GitHub OAuth App client secret (wrangler secret)
 *   ALLOWED_ORIGIN              — e.g. https://zilimeng.com
 *   TENANTS                     — KV namespace binding for per-org tenant records
 */

import { getByOrg, put, type KVEnv, type TenantRecord } from './kv.js';
import { verifyGitHubSignature } from './verify-github.js';
import { dispatchRepoEvent } from './dispatch.js';

export interface Env extends KVEnv {
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  ALLOWED_ORIGIN: string;
}

const SCOPES = 'repo workflow admin:org admin:org_hook';
/** Repo events we forward (filtered out the rest). */
const FORWARDED_REPO_ACTIONS = new Set([
  'created',
  'deleted',
  'renamed',
  'archived',
  'unarchived',
]);

function cors(env: Env): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function getCookie(req: Request, name: string): string | null {
  const header = req.headers.get('Cookie') || '';
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function json(data: unknown, status: number, env: Env): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors(env) },
  });
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
      if (url.pathname === '/api/register-tenant' && req.method === 'POST')
        return await registerTenant(req, env);

      const ghMatch = url.pathname.match(/^\/webhook\/github\/([^/]+)\/?$/);
      if (ghMatch && req.method === 'POST') return await githubWebhook(req, ghMatch[1], env);

      return new Response('Not found', { status: 404 });
    } catch (err) {
      console.error('Worker error:', err);
      return new Response(`Internal error: ${err}`, { status: 500 });
    }
  },
};

// ---------------------------------------------------------------------------
// GET /auth/github?state=RANDOM
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
// ---------------------------------------------------------------------------
async function callbackGitHub(req: Request, url: URL, env: Env): Promise<Response> {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return new Response('Missing code or state', { status: 400 });

  const cookieState = getCookie(req, 'oauth_state');
  if (cookieState !== state) {
    return new Response('State mismatch — possible CSRF. Please try again.', { status: 403 });
  }

  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
    }),
  });

  const data = (await tokenRes.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!data.access_token) {
    return new Response(
      `GitHub OAuth failed: ${data.error_description || data.error || 'unknown'}`,
      { status: 502 },
    );
  }

  const callbackPage = `${env.ALLOWED_ORIGIN}/lark-github-sync/callback.html`;

  return new Response(null, {
    status: 302,
    headers: new Headers([
      ['Location', `${callbackPage}#token=${data.access_token}`],
      ['Set-Cookie', 'oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0'],
    ]),
  });
}

// ---------------------------------------------------------------------------
// POST /api/verify-lark
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

  const base = body.domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';

  const res = await fetch(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: body.app_id, app_secret: body.app_secret }),
  });

  const data = (await res.json()) as {
    code?: number;
    msg?: string;
    tenant_access_token?: string;
  };

  if (data.code === 0 && data.tenant_access_token) {
    return json({ valid: true }, 200, env);
  }
  return json({ valid: false, error: data.msg || 'Invalid credentials' }, 200, env);
}

// ---------------------------------------------------------------------------
// POST /api/register-tenant
// Authorization: Bearer <github-oauth-token>
// Body: { org, syncRepo, dispatchPat, webhookSecret, adminChatId }
// ---------------------------------------------------------------------------
async function registerTenant(req: Request, env: Env): Promise<Response> {
  const origin = req.headers.get('Origin') || '';
  if (!origin.startsWith(env.ALLOWED_ORIGIN)) {
    return new Response('Forbidden', { status: 403 });
  }

  const auth = req.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) {
    return json({ error: 'Missing Authorization: Bearer <token>' }, 401, env);
  }
  const token = auth.slice('Bearer '.length);

  const body = (await req.json()) as Partial<TenantRecord>;
  const { org, syncRepo, dispatchPat, webhookSecret, adminChatId } = body;

  for (const [name, val] of Object.entries({ org, syncRepo, dispatchPat, webhookSecret, adminChatId })) {
    if (!val || typeof val !== 'string') {
      return json({ error: `Missing or invalid field: ${name}` }, 400, env);
    }
  }

  // Verify caller is an admin of the named org
  const memRes = await fetch(`https://api.github.com/user/memberships/orgs/${org}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'lark-github-sync-worker',
    },
  });
  if (memRes.status !== 200) {
    return json(
      { error: `Not a member of org "${org}" (or token lacks admin:org scope)` },
      403,
      env,
    );
  }
  const membership = (await memRes.json()) as { role?: string };
  if (membership.role !== 'admin') {
    return json({ error: `Must be an admin of "${org}" (you are "${membership.role}")` }, 403, env);
  }

  await put(env, {
    org: org!,
    syncRepo: syncRepo!,
    dispatchPat: dispatchPat!,
    webhookSecret: webhookSecret!,
    adminChatId: adminChatId!,
    registeredAt: '',
    updatedAt: '',
  });

  const webhookUrl = `${new URL(req.url).origin}/webhook/github/${org}`;
  return json({ ok: true, webhookUrl }, 200, env);
}

// ---------------------------------------------------------------------------
// POST /webhook/github/:org
// ---------------------------------------------------------------------------
async function githubWebhook(req: Request, org: string, env: Env): Promise<Response> {
  const tenant = await getByOrg(env, org);
  if (!tenant) {
    return new Response(`Unknown tenant "${org}"`, { status: 404 });
  }

  const rawBody = await req.text();
  const signature = req.headers.get('X-Hub-Signature-256');
  const ok = await verifyGitHubSignature(tenant.webhookSecret, rawBody, signature);
  if (!ok) {
    return new Response('Bad signature', { status: 401 });
  }

  const event = req.headers.get('X-GitHub-Event') ?? '';
  if (event === 'ping') {
    return json({ pong: true }, 200, env);
  }

  const payload = JSON.parse(rawBody);
  const action: string = payload.action ?? '';

  if (event === 'repository') {
    if (!FORWARDED_REPO_ACTIONS.has(action)) {
      return json({ skipped: `action ${action} not forwarded` }, 200, env);
    }
    const repo = payload.repository ?? {};
    const clientPayload = {
      action,
      full_name: repo.full_name,
      id: repo.id,
      html_url: repo.html_url,
      default_branch: repo.default_branch,
      private: repo.private,
      description: repo.description,
      old_name: action === 'renamed' ? payload.changes?.repository?.name?.from : undefined,
    };
    await dispatchRepoEvent({
      syncRepo: tenant.syncRepo,
      pat: tenant.dispatchPat,
      eventType: 'repo-changed',
      clientPayload,
    });
    return json({ ok: true, action, repo: repo.full_name }, 200, env);
  }

  if (event === 'organization') {
    // Fire when someone accepts the org invitation
    if (action !== 'member_added') {
      return json({ skipped: `action ${action} not forwarded` }, 200, env);
    }
    const member = payload.membership?.user ?? {};
    const clientPayload = {
      action,
      login: member.login,
      id: member.id,
      avatar_url: member.avatar_url,
      html_url: member.html_url,
    };
    await dispatchRepoEvent({
      syncRepo: tenant.syncRepo,
      pat: tenant.dispatchPat,
      eventType: 'member-joined',
      clientPayload,
    });
    return json({ ok: true, action, login: member.login }, 200, env);
  }

  return json({ skipped: `event ${event} not forwarded` }, 200, env);
}
