/**
 * Per-repo helpers shared between the bulk `sync-repos.ts` / `setup-repos.ts`
 * and the real-time `handle-repo-event.ts` handler.
 */

import type { Octokit } from '@octokit/rest';
import {
  createGroupChat,
  sendCardMessage,
  getLarkClient,
} from './lark.js';
import type { GitHubRepo, RepoChatMapping } from './types.js';
import { repoArchivedCard, repoDeletedCard, repoRenamedCard } from './cards.js';

export const NOTIFY_WORKFLOW_PATH = '.github/workflows/lark-notify.yml';

export function chatNameForRepo(fullName: string): string {
  return `GitHub: ${fullName}`;
}

function welcomeCard(repo: GitHubRepo) {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `🔗 Connected: ${repo.full_name}` },
      template: 'blue',
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: [
            `**Repository:** [${repo.full_name}](${repo.html_url})`,
            repo.description ? `**Description:** ${repo.description}` : null,
            `**Visibility:** ${repo.private ? 'Private' : 'Public'}`,
            `**Default branch:** \`${repo.default_branch}\``,
            '',
            'This group chat will receive GitHub notifications for this repository.',
          ]
            .filter(Boolean)
            .join('\n'),
        },
      },
    ],
  };
}

async function setRepoVariable(
  octokit: Octokit,
  owner: string,
  repo: string,
  name: string,
  value: string,
): Promise<void> {
  try {
    await octokit.actions.updateRepoVariable({ owner, repo, name, value });
  } catch {
    await octokit.actions.createRepoVariable({ owner, repo, name, value });
  }
}

/**
 * Look up an existing mapping entry for a repo, preferring `repo_id` lookup
 * (survives renames) and falling back to the current `full_name`.
 */
export function findMappingEntry(
  mapping: RepoChatMapping,
  repo: { full_name: string; id?: number },
) {
  if (repo.id) {
    for (const [key, entry] of Object.entries(mapping)) {
      if (entry.repo_id === repo.id) return { key, entry };
    }
  }
  if (mapping[repo.full_name]) {
    return { key: repo.full_name, entry: mapping[repo.full_name] };
  }
  return null;
}

export interface EnsureRepoChatResult {
  chat_id: string;
  created: boolean;
  mappingKey: string;
}

/**
 * Ensure a Lark chat exists for this repo, the mapping is up to date, and the
 * `LARK_CHAT_ID` repo variable is set. Safe to call many times — no-op when
 * everything is already in place. Also handles the case where the mapping has
 * the repo under an older name (rename).
 */
export async function ensureRepoChat(
  octokit: Octokit,
  repo: GitHubRepo & { id?: number },
  mapping: RepoChatMapping,
  existingChats: Map<string, string>,
  opts: { owner: string; dryRun: boolean },
): Promise<EnsureRepoChatResult> {
  const existing = findMappingEntry(mapping, repo);
  const chatName = chatNameForRepo(repo.full_name);

  // Path 1: mapping already has an entry — rename-safe via repo_id.
  if (existing) {
    // Migrate the mapping key if the repo was renamed
    if (existing.key !== repo.full_name) {
      const entry = existing.entry;
      entry.renames = entry.renames ?? [];
      if (!entry.renames.includes(existing.key)) entry.renames.push(existing.key);
      entry.chat_name = chatName;
      delete mapping[existing.key];
      mapping[repo.full_name] = entry;
    }
    // Ensure repo_id is populated going forward
    if (repo.id && !mapping[repo.full_name].repo_id) {
      mapping[repo.full_name].repo_id = repo.id;
    }
    return {
      chat_id: mapping[repo.full_name].chat_id,
      created: false,
      mappingKey: repo.full_name,
    };
  }

  // Path 2: chat exists in Lark but not in mapping (recovery).
  const recoveredChatId = existingChats.get(chatName);
  if (recoveredChatId) {
    mapping[repo.full_name] = {
      chat_id: recoveredChatId,
      chat_name: chatName,
      created_at: new Date().toISOString(),
      repo_id: repo.id,
      renames: [],
    };
    return { chat_id: recoveredChatId, created: false, mappingKey: repo.full_name };
  }

  // Path 3: brand new — create the chat.
  if (opts.dryRun) {
    return { chat_id: '<dry-run>', created: true, mappingKey: repo.full_name };
  }

  const description = `GitHub notifications for ${repo.full_name}${repo.description ? ` — ${repo.description}` : ''}`;
  const chatId = await createGroupChat(chatName, description);

  mapping[repo.full_name] = {
    chat_id: chatId,
    chat_name: chatName,
    created_at: new Date().toISOString(),
    repo_id: repo.id,
    renames: [],
  };

  try {
    await sendCardMessage(chatId, welcomeCard(repo));
  } catch (err) {
    console.warn(`  ⚠ failed to send welcome message: ${err}`);
  }

  try {
    await setRepoVariable(octokit, opts.owner, repo.name, 'LARK_CHAT_ID', chatId);
  } catch (err) {
    console.warn(`  ⚠ failed to set LARK_CHAT_ID variable: ${err}`);
  }

  return { chat_id: chatId, created: true, mappingKey: repo.full_name };
}

/** Notification workflow content — same file pushed into every org repo. */
export function notifyWorkflowYaml(syncRepoFullName: string): string {
  return `# Auto-generated by feishu-github-sync — do not edit manually.
# This workflow sends GitHub event notifications to the linked Lark group chat.
# Source: https://github.com/${syncRepoFullName}

name: Lark Notifications

on:
  push:
    branches: [main, master]
  issues:
    types: [opened, closed, reopened, assigned, labeled]
  issue_comment:
    types: [created]
  pull_request:
    types: [opened, closed, reopened, ready_for_review, review_requested]
  pull_request_review:
    types: [submitted]
  release:
    types: [published]
  create:
  delete:
  fork:
  workflow_run:
    workflows: ["*"]
    types: [completed]

permissions:
  contents: read

jobs:
  notify-lark:
    runs-on: ubuntu-latest
    # Only run for non-bot events to avoid loops
    if: github.actor != 'github-actions[bot]'
    steps:
      - name: Checkout feishu-github-sync
        uses: actions/checkout@v4
        with:
          repository: ${syncRepoFullName}
          token: \${{ secrets.SYNC_GITHUB_TOKEN }}

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "npm"

      - name: Install dependencies
        run: npm ci

      - name: Send Lark notification
        env:
          LARK_APP_ID: \${{ secrets.LARK_APP_ID }}
          LARK_APP_SECRET: \${{ secrets.LARK_APP_SECRET }}
          LARK_DOMAIN: \${{ vars.LARK_DOMAIN || 'feishu' }}
          LARK_CHAT_ID: \${{ vars.LARK_CHAT_ID }}
          GITHUB_EVENT_NAME: \${{ github.event_name }}
          GITHUB_EVENT_PATH: \${{ github.event_path }}
        run: npx tsx src/notify.ts
`;
}

export type PushWorkflowStatus = 'created' | 'updated' | 'skipped';

/**
 * Create or update `.github/workflows/lark-notify.yml` in the given repo.
 * No-op if the existing content already matches.
 */
export async function pushNotifyWorkflow(
  octokit: Octokit,
  owner: string,
  repoName: string,
  branch: string,
  syncRepoFullName: string,
  opts: { dryRun: boolean },
): Promise<PushWorkflowStatus> {
  const content = notifyWorkflowYaml(syncRepoFullName);
  const contentBase64 = Buffer.from(content).toString('base64');

  let existingSha: string | undefined;
  try {
    const existing = await octokit.repos.getContent({
      owner,
      repo: repoName,
      path: NOTIFY_WORKFLOW_PATH,
    });
    if ('sha' in existing.data) {
      existingSha = existing.data.sha;
      if ('content' in existing.data) {
        const existingContent = Buffer.from(
          (existing.data.content as string).replace(/\n/g, ''),
          'base64',
        ).toString();
        if (existingContent === content) return 'skipped';
      }
    }
  } catch {
    // File doesn't exist yet
  }

  if (opts.dryRun) return existingSha ? 'updated' : 'created';

  await octokit.repos.createOrUpdateFileContents({
    owner,
    repo: repoName,
    path: NOTIFY_WORKFLOW_PATH,
    message: existingSha
      ? 'chore: update Lark notification workflow'
      : 'chore: add Lark notification workflow',
    content: contentBase64,
    sha: existingSha,
    branch,
  });

  return existingSha ? 'updated' : 'created';
}

/** Rename the Lark chat for a repo whose name changed on GitHub. */
export async function renameRepoChat(
  chatId: string,
  newFullName: string,
  htmlUrl: string,
  oldFullName: string,
): Promise<void> {
  const client = getLarkClient();
  await client.im.chat.update({
    data: { name: chatNameForRepo(newFullName) },
    path: { chat_id: chatId },
  });
  try {
    await sendCardMessage(chatId, repoRenamedCard(oldFullName, newFullName, htmlUrl));
  } catch (err) {
    console.warn(`  ⚠ failed to send rename notice: ${err}`);
  }
}

export async function sendRepoArchivedNotice(
  chatId: string,
  fullName: string,
  htmlUrl: string,
): Promise<void> {
  await sendCardMessage(chatId, repoArchivedCard(fullName, htmlUrl));
}

export async function sendRepoDeletedNotice(
  chatId: string,
  fullName: string,
): Promise<void> {
  await sendCardMessage(chatId, repoDeletedCard(fullName));
}
