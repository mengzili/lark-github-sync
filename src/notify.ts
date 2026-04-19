/**
 * Send a GitHub event notification to the appropriate Lark group chat.
 *
 * Expected env vars:
 *   LARK_APP_ID, LARK_APP_SECRET        — Lark app credentials
 *   LARK_DOMAIN                          — "feishu" (default) or "lark"
 *   GITHUB_EVENT_NAME                    — e.g. "push", "issues"
 *   GITHUB_EVENT_PATH                    — path to the event payload JSON
 *   GITHUB_REPOSITORY                    — e.g. "org/repo"
 *   LARK_CHAT_ID                         — (optional) direct chat ID override
 *
 * If LARK_CHAT_ID is not set, the script searches for a chat named "GitHub: {repo}".
 */

import fs from 'node:fs';
import * as lark from '@larksuiteoapi/node-sdk';
import { initLarkClient, listBotChats, sendCardMessage, addMembersToChat, formatLarkError } from './lark.js';
import {
  pushCard,
  issueCard,
  issueCommentCard,
  pullRequestCard,
  pullRequestReviewCard,
  releaseCard,
  createRefCard,
  deleteRefCard,
  forkCard,
  starCard,
  workflowRunCard,
  genericEventCard,
} from './cards.js';
import { loadUserMapping, larkIdForGithub } from './user-mapping.js';
import type { UserMapping } from './types.js';

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Required env var ${name} is not set`);
  return v;
}

/** Build the card for a given event type + payload. */
function buildCard(eventName: string, payload: any, mapping: UserMapping): object | null {
  // Filter out noisy events
  if (eventName === 'workflow_run' && payload.action !== 'completed') return null;
  if (eventName === 'star' && payload.action === 'deleted') return null;
  if (eventName === 'push' && (payload.commits ?? []).length === 0 && !payload.forced) return null;

  switch (eventName) {
    case 'push': return pushCard(payload);
    case 'issues': return issueCard(payload);
    case 'issue_comment': return issueCommentCard(payload);
    case 'pull_request': return pullRequestCard(payload, mapping);
    case 'pull_request_review': return pullRequestReviewCard(payload, mapping);
    case 'release': return releaseCard(payload);
    case 'create': return createRefCard(payload);
    case 'delete': return deleteRefCard(payload);
    case 'fork': return forkCard(payload);
    case 'star': return starCard(payload);
    case 'workflow_run': return workflowRunCard(payload);
    default: return genericEventCard(eventName, payload);
  }
}

async function resolveChatId(repo: string): Promise<string> {
  // Direct override via env
  const direct = process.env.LARK_CHAT_ID;
  if (direct) return direct;

  // Search by naming convention
  const chatName = `GitHub: ${repo}`;
  console.log(`  Looking up chat "${chatName}"...`);
  const chats = await listBotChats();
  const chatId = chats.get(chatName);
  if (!chatId) {
    throw new Error(
      `No Lark chat found for "${chatName}". Run sync-repos first, or set LARK_CHAT_ID.`,
    );
  }
  return chatId;
}

async function main() {
  const appId = requiredEnv('LARK_APP_ID');
  const appSecret = requiredEnv('LARK_APP_SECRET');
  const eventName = requiredEnv('GITHUB_EVENT_NAME');
  const eventPath = requiredEnv('GITHUB_EVENT_PATH');
  const repo = requiredEnv('GITHUB_REPOSITORY');

  const domain =
    process.env.LARK_DOMAIN === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu;

  // Init client directly (we don't need full config here)
  initLarkClient({
    larkAppId: appId,
    larkAppSecret: appSecret,
    larkDomain: domain,
    larkSourceDepartmentId: '0',
    githubToken: '',
    githubOrg: '',
    dryRun: false,
  });

  // Load the user mapping (for @-mentions). Absent file is fine — treat as empty.
  const mapping = loadUserMapping();

  // Read event payload
  const payload = JSON.parse(fs.readFileSync(eventPath, 'utf-8'));

  console.log(`Event: ${eventName} (action: ${payload.action ?? 'n/a'})`);
  console.log(`Repo:  ${repo}`);

  // Build card
  const card = buildCard(eventName, payload, mapping);
  if (!card) {
    console.log('Event filtered out (not actionable). Skipping notification.');
    return;
  }

  // Resolve chat
  const chatId = await resolveChatId(repo);
  console.log(`Chat:  ${chatId}`);

  // Send
  await sendCardMessage(chatId, card);
  console.log('Notification sent successfully.');

  // Ensure everyone relevant to this event is in the chat. Lark's addMembers
  // is idempotent — members already in silently no-op. This is how new org
  // joiners get auto-added: their first contribution fires an event, notify
  // runs, and they land in the chat.
  const logins = new Set<string>();
  if (payload.sender?.login) logins.add(payload.sender.login);
  if (payload.pusher?.name) logins.add(payload.pusher.name);
  if (payload.pull_request?.user?.login) logins.add(payload.pull_request.user.login);
  if (payload.issue?.user?.login) logins.add(payload.issue.user.login);
  for (const r of payload.pull_request?.requested_reviewers ?? []) {
    if (r.login) logins.add(r.login);
  }
  const openIds: string[] = [];
  for (const login of logins) {
    const id = larkIdForGithub(mapping, login);
    if (id) openIds.push(id);
  }
  if (openIds.length > 0) {
    try {
      await addMembersToChat(chatId, openIds);
      console.log(`Ensured ${openIds.length} matched user(s) in chat.`);
    } catch (err) {
      // Best effort — don't fail the notify job if add-members has a hiccup
      console.warn(`Could not add members to chat: ${err}`);
    }
  }
}

main().catch((err) => {
  console.error('Failed to send notification:', formatLarkError(err));
  process.exit(1);
});
