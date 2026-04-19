/**
 * Bulk sync: walks every repo in the GitHub org and ensures a Lark group chat
 * exists for each, with a recovery path for chats that already exist but are
 * missing from the mapping file.
 *
 * Delegates the per-repo work to `ensureRepoChat` in src/repos.ts — same
 * helper the real-time `handle-repo-event.ts` uses.
 */

import { Octokit } from '@octokit/rest';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import {
  initLarkClient,
  listBotChats,
  formatLarkError,
} from './lark.js';
import { ensureRepoChat } from './repos.js';
import type { GitHubRepo, RepoChatMapping, RepoSyncResult } from './types.js';

const DATA_DIR = path.resolve(import.meta.dirname, '..', 'data');
const MAPPING_FILE = path.join(DATA_DIR, 'repo-chat-mapping.json');

async function fetchOrgRepos(
  octokit: Octokit,
  org: string,
): Promise<Array<GitHubRepo & { id: number }>> {
  const repos: Array<GitHubRepo & { id: number }> = [];
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
        id: repo.id,
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

async function main() {
  const config = loadConfig();
  initLarkClient(config);
  const octokit = new Octokit({ auth: config.githubToken });

  console.log(`=== Repo Sync: ${config.githubOrg} → Lark group chats ===\n`);

  console.log('1. Fetching GitHub org repos...');
  const repos = await fetchOrgRepos(octokit, config.githubOrg);
  console.log(`   Found ${repos.length} repos\n`);

  const mapping = loadMapping();
  console.log(`2. Loaded mapping with ${Object.keys(mapping).length} existing entries\n`);

  console.log('3. Checking existing Lark chats...');
  const existingChats = await listBotChats();
  console.log(`   Bot is in ${existingChats.size} chats\n`);

  console.log('4. Processing repos...');
  const result: RepoSyncResult = { created: [], existing: [], errors: [] };
  const adminOpenId = process.env.LARK_ADMIN_OPEN_ID || '';

  for (const repo of repos) {
    try {
      const r = await ensureRepoChat(octokit, repo, mapping, existingChats, {
        owner: config.githubOrg,
        dryRun: config.dryRun,
        adminOpenIds: adminOpenId ? [adminOpenId] : [],
      });
      if (r.created) {
        result.created.push(repo.full_name);
        console.log(`   + Created chat for ${repo.full_name}: ${r.chat_id}`);
      } else {
        result.existing.push(repo.full_name);
      }
    } catch (err) {
      result.errors.push(`${repo.full_name}: ${err}`);
      console.error(`   ✗ Failed for ${repo.full_name}: ${err}`);
    }
  }

  if (!config.dryRun) {
    saveMapping(mapping);
    console.log(`\n5. Saved mapping to ${MAPPING_FILE}`);
  }

  console.log('\n=== Summary ===');
  console.log(`Existing: ${result.existing.length}`);
  console.log(`Created:  ${result.created.length}`);
  console.log(`Errors:   ${result.errors.length}`);

  if (result.errors.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Fatal error:', formatLarkError(err));
  process.exit(1);
});
