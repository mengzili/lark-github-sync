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
import { initLarkClient, listBotChats, sendCardMessage } from './lark.js';
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
import type { GitHubEventType } from './types.js';

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Required env var ${name} is not set`);
  return v;
}

/** Build the card for a given event type + payload. */
function buildCard(eventName: string, payload: any): object | null {
  const builders: Record<string, (p: any) => object> = {
    push: pushCard,
    issues: issueCard,
    issue_comment: issueCommentCard,
    pull_request: pullRequestCard,
    pull_request_review: pullRequestReviewCard,
    release: releaseCard,
    create: createRefCard,
    delete: deleteRefCard,
    fork: forkCard,
    star: starCard,
    workflow_run: workflowRunCard,
  };

  // Filter out noisy events
  if (eventName === 'workflow_run' && payload.action !== 'completed') return null;
  if (eventName === 'star' && payload.action === 'deleted') return null;
  if (eventName === 'push' && (payload.commits ?? []).length === 0 && !payload.forced) return null;

  const builder = builders[eventName];
  if (builder) return builder(payload);
  return genericEventCard(eventName, payload);
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
    larkDepartmentName: '',
    githubToken: '',
    githubOrg: '',
    dryRun: false,
    syncRemoveMembers: false,
  });

  // Read event payload
  const payload = JSON.parse(fs.readFileSync(eventPath, 'utf-8'));

  console.log(`Event: ${eventName} (action: ${payload.action ?? 'n/a'})`);
  console.log(`Repo:  ${repo}`);

  // Build card
  const card = buildCard(eventName, payload);
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
}

main().catch((err) => {
  console.error('Failed to send notification:', err);
  process.exit(1);
});
