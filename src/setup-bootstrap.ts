/**
 * One-shot bootstrap: admin chat + GitHub org webhook + tenant registration.
 *
 * Runs during `initial-setup.yml` (and again any time the user re-runs setup
 * to rotate the webhook secret). Idempotent.
 *
 * Steps:
 *   1. Resolve the caller's Lark open_id from their email — used to seed the
 *      admin chat membership.
 *   2. Create the "Lark-GitHub Sync Admin" chat if it doesn't exist.
 *   3. Store the chat id as a GitHub org variable `LARK_ADMIN_CHAT_ID`.
 *   4. Generate a fresh webhook secret, register (or update) the GitHub org
 *      webhook pointing to the central Worker.
 *   5. POST the tenant config (secret + dispatch token + admin chat id) to the
 *      Worker's /api/register-tenant endpoint.
 *
 * Env:
 *   LARK_APP_ID, LARK_APP_SECRET, LARK_DOMAIN
 *   GITHUB_TOKEN         — caller's OAuth token (must have admin:org on the org)
 *   GITHUB_ORG
 *   GITHUB_REPOSITORY    — "org/sync-repo"
 *   ADMIN_EMAIL          — caller's email (for Lark open_id resolution)
 *   WORKER_BASE_URL      — e.g. https://feishu-github-sync-oauth.workers.dev
 */

import { Octokit } from '@octokit/rest';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import {
  initLarkClient,
  batchGetUserIdsByEmail,
  createGroupChat,
  listBotChats,
  formatLarkError,
} from './lark.js';
import { loadConfig } from './config.js';

const ADMIN_CHAT_NAME = 'Lark-GitHub Sync Admin';

function requiredEnv(n: string): string {
  const v = process.env[n];
  if (!v) throw new Error(`Required env var ${n} is not set`);
  return v;
}

function ghSetOrgVariable(org: string, name: string, value: string, token: string) {
  const env = { ...process.env, GH_TOKEN: token };
  try {
    execSync(
      `gh variable set ${name} --org "${org}" --visibility all --body "${value}"`,
      { env, stdio: 'pipe' },
    );
  } catch (err: any) {
    throw new Error(`Failed to set org variable ${name}: ${err.stderr?.toString() ?? err.message}`);
  }
}

async function main() {
  const config = loadConfig();
  initLarkClient(config);
  const octokit = new Octokit({ auth: config.githubToken });

  const org = config.githubOrg;
  const syncRepo = process.env.GITHUB_REPOSITORY ?? `${org}/lark-github-sync`;
  const adminEmail = requiredEnv('ADMIN_EMAIL').toLowerCase();
  const workerBase = process.env.WORKER_BASE_URL ?? 'https://feishu-github-sync-oauth.zilim.workers.dev';

  console.log(`=== Bootstrap: ${org} → central worker ===\n`);
  console.log(`sync repo: ${syncRepo}`);
  console.log(`admin:     ${adminEmail}`);
  console.log(`worker:    ${workerBase}\n`);

  // ── 1. Resolve caller's Lark open_id ─────────────────────────────────
  console.log('1. Resolving admin Lark open_id by email...');
  const emailToId = await batchGetUserIdsByEmail([adminEmail]);
  const adminOpenId = emailToId.get(adminEmail);
  if (!adminOpenId) {
    console.warn(`   ⚠ no Lark user found for ${adminEmail} — creating empty admin chat`);
  } else {
    console.log(`   admin open_id: ${adminOpenId}`);
  }

  // ── 2. Find or create the admin chat ─────────────────────────────────
  console.log('\n2. Ensuring admin chat...');
  const existingChats = await listBotChats();
  let adminChatId = existingChats.get(ADMIN_CHAT_NAME);
  if (adminChatId) {
    console.log(`   reusing existing admin chat: ${adminChatId}`);
  } else {
    adminChatId = await createGroupChat(
      ADMIN_CHAT_NAME,
      `Receives approval prompts for ${org} member sync. Approve from the web page.`,
      adminOpenId ? [adminOpenId] : undefined,
    );
    console.log(`   + created admin chat: ${adminChatId}`);
  }

  // ── 3. Store chat id + admin open_id as org variables ────────────────
  console.log('\n3. Setting LARK_ADMIN_CHAT_ID on org...');
  ghSetOrgVariable(org, 'LARK_ADMIN_CHAT_ID', adminChatId, config.githubToken);
  console.log(`   LARK_ADMIN_CHAT_ID = ${adminChatId}`);
  if (adminOpenId) {
    ghSetOrgVariable(org, 'LARK_ADMIN_OPEN_ID', adminOpenId, config.githubToken);
    console.log(`   LARK_ADMIN_OPEN_ID = ${adminOpenId}`);
  }

  // ── 4. Register GitHub org webhook ───────────────────────────────────
  console.log('\n4. Registering GitHub org webhook...');
  const webhookSecret = crypto.randomBytes(32).toString('hex');
  const webhookUrl = `${workerBase}/webhook/github/${org}`;

  // Find any existing webhook for the same URL (so we update instead of duplicate)
  const hooks = await octokit.orgs.listWebhooks({ org });
  const existing = hooks.data.find((h) => h.config?.url === webhookUrl);

  if (existing) {
    await octokit.orgs.updateWebhook({
      org,
      hook_id: existing.id,
      events: ['repository'],
      active: true,
      config: {
        url: webhookUrl,
        secret: webhookSecret,
        content_type: 'json',
        insecure_ssl: '0',
      },
    });
    console.log(`   ~ updated existing webhook (id=${existing.id})`);
  } else {
    const created = await octokit.orgs.createWebhook({
      org,
      name: 'web',
      events: ['repository'],
      active: true,
      config: {
        url: webhookUrl,
        secret: webhookSecret,
        content_type: 'json',
        insecure_ssl: '0',
      },
    });
    console.log(`   + created webhook (id=${created.data.id})`);
  }

  // ── 5. Register tenant with the worker ───────────────────────────────
  console.log('\n5. Registering tenant with worker...');
  const res = await fetch(`${workerBase}/api/register-tenant`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.githubToken}`,
      Origin: 'https://zilimeng.com',
    },
    body: JSON.stringify({
      org,
      syncRepo,
      dispatchPat: config.githubToken, // caller's token (has admin:org + workflow)
      webhookSecret,
      adminChatId,
    }),
  });
  if (!res.ok) {
    throw new Error(`Worker registration failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { ok?: boolean; webhookUrl?: string };
  console.log(`   tenant registered → ${body.webhookUrl}`);

  console.log('\n=== Bootstrap complete ===');
  console.log(`Admin chat:    ${adminChatId}`);
  console.log(`Webhook URL:   ${webhookUrl}`);
  console.log('The worker will now forward repository events to this repo.');
}

main().catch((err) => {
  console.error('Bootstrap failed:', formatLarkError(err));
  process.exit(1);
});
