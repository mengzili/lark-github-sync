/**
 * Sync GitHub organization repos → Lark group chats.
 *
 * Flow:
 *   1. Fetch all GitHub org repos
 *   2. Load existing repo→chat mapping
 *   3. Create Lark group chats for new repos
 *   4. Set LARK_CHAT_ID as a GitHub repo variable on each repo
 *   5. Save updated mapping
 */

import { Octokit } from '@octokit/rest';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import {
  initLarkClient,
  createGroupChat,
  listBotChats,
  sendCardMessage,
  formatLarkError,
} from './lark.js';
import type { GitHubRepo, RepoChatMapping, RepoSyncResult } from './types.js';

const DATA_DIR = path.resolve(import.meta.dirname, '..', 'data');
const MAPPING_FILE = path.join(DATA_DIR, 'repo-chat-mapping.json');

/** Chat name convention: "GitHub: org/repo" */
function chatNameForRepo(repoFullName: string): string {
  return `GitHub: ${repoFullName}`;
}

async function fetchOrgRepos(octokit: Octokit, org: string): Promise<GitHubRepo[]> {
  const repos: GitHubRepo[] = [];

  for await (const response of octokit.paginate.iterator(octokit.repos.listForOrg, {
    org,
    per_page: 100,
    type: 'all',
  })) {
    for (const repo of response.data) {
      repos.push({
        name: repo.name,
        full_name: repo.full_name,
        description: repo.description ?? null,
        html_url: repo.html_url,
        private: repo.private,
        default_branch: repo.default_branch ?? 'main',
      });
    }
  }

  return repos;
}

function loadMapping(): RepoChatMapping {
  if (!fs.existsSync(MAPPING_FILE)) return {};
  return JSON.parse(fs.readFileSync(MAPPING_FILE, 'utf-8'));
}

function saveMapping(mapping: RepoChatMapping): void {
  fs.writeFileSync(MAPPING_FILE, JSON.stringify(mapping, null, 2) + '\n');
}

async function setRepoVariable(
  octokit: Octokit,
  owner: string,
  repo: string,
  name: string,
  value: string,
): Promise<void> {
  try {
    // Try to update existing variable
    await octokit.actions.updateRepoVariable({ owner, repo, name, value });
  } catch {
    // Variable doesn't exist yet — create it
    await octokit.actions.createRepoVariable({ owner, repo, name, value });
  }
}

function makeWelcomeCard(repo: GitHubRepo): object {
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

async function main() {
  const config = loadConfig();
  initLarkClient(config);
  const octokit = new Octokit({ auth: config.githubToken });

  console.log(`=== Repo Sync: ${config.githubOrg} → Lark group chats ===\n`);

  // 1. Fetch org repos
  console.log('1. Fetching GitHub org repos...');
  const repos = await fetchOrgRepos(octokit, config.githubOrg);
  console.log(`   Found ${repos.length} repos\n`);

  // 2. Load existing mapping
  const mapping = loadMapping();
  const existingCount = Object.keys(mapping).length;
  console.log(`2. Loaded mapping with ${existingCount} existing entries\n`);

  // 3. Get existing bot chats (for recovery if mapping is lost)
  console.log('3. Checking existing Lark chats...');
  const existingChats = await listBotChats();
  console.log(`   Bot is in ${existingChats.size} chats\n`);

  // 4. Process repos
  console.log('4. Processing repos...');
  const result: RepoSyncResult = { created: [], existing: [], errors: [] };

  for (const repo of repos) {
    const chatName = chatNameForRepo(repo.full_name);

    // Already in mapping?
    if (mapping[repo.full_name]) {
      result.existing.push(repo.full_name);
      continue;
    }

    // Exists in Lark but not in mapping? (recovery)
    const existingChatId = existingChats.get(chatName);
    if (existingChatId) {
      console.log(`   ~ Recovered mapping for ${repo.full_name}: ${existingChatId}`);
      mapping[repo.full_name] = {
        chat_id: existingChatId,
        chat_name: chatName,
        created_at: new Date().toISOString(),
      };
      result.existing.push(repo.full_name);
      continue;
    }

    // Create new chat
    if (config.dryRun) {
      console.log(`   [DRY RUN] Would create chat: "${chatName}"`);
      result.created.push(repo.full_name);
      continue;
    }

    try {
      const description = `GitHub notifications for ${repo.full_name}${repo.description ? ` — ${repo.description}` : ''}`;
      const chatId = await createGroupChat(chatName, description);
      mapping[repo.full_name] = {
        chat_id: chatId,
        chat_name: chatName,
        created_at: new Date().toISOString(),
      };
      result.created.push(repo.full_name);
      console.log(`   + Created chat for ${repo.full_name}: ${chatId}`);

      // Send welcome message
      try {
        await sendCardMessage(chatId, makeWelcomeCard(repo));
      } catch (err) {
        console.warn(`     ⚠ Failed to send welcome message: ${err}`);
      }

      // Set GitHub repo variable so notification workflows can find the chat
      try {
        await setRepoVariable(
          octokit,
          config.githubOrg,
          repo.name,
          'LARK_CHAT_ID',
          chatId,
        );
        console.log(`     Set LARK_CHAT_ID variable on ${repo.full_name}`);
      } catch (err) {
        console.warn(`     ⚠ Failed to set repo variable: ${err}`);
      }
    } catch (err) {
      result.errors.push(`${repo.full_name}: ${err}`);
      console.error(`   ✗ Failed for ${repo.full_name}: ${err}`);
    }
  }

  // 5. Save updated mapping
  if (!config.dryRun) {
    saveMapping(mapping);
    console.log(`\n5. Saved mapping to ${MAPPING_FILE}`);
  }

  // Summary
  console.log('\n=== Summary ===');
  console.log(`Existing: ${result.existing.length}`);
  console.log(`Created:  ${result.created.length}`);
  console.log(`Errors:   ${result.errors.length}`);

  if (result.errors.length > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', formatLarkError(err));
  process.exit(1);
});
