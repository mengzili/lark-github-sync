/**
 * Handle a `member-joined` event dispatched by the Worker when someone
 * accepts the GitHub org invitation.
 *
 * Flow:
 *   1. Load user-mapping. If the new member isn't matched yet, try to
 *      resolve them now (they're a fresh org member so sync-members may
 *      not have seen them yet).
 *   2. If matched (now or previously), find every repo in the org that
 *      lists them as a contributor (commits or PR authorship) and add
 *      their Lark open_id to each repo's chat.
 *
 * No-op if the user has no Lark mapping — they'll be handled by the
 * next scheduled sync-members / approval flow.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Octokit } from '@octokit/rest';
import { loadConfig } from './config.js';
import {
  initLarkClient,
  addMembersToChat,
  batchGetUserIdsByEmail,
  listDepartmentMembersDetailed,
  formatLarkError,
} from './lark.js';
import { loadUserMapping, saveUserMapping, recordMatch, larkIdForGithub } from './user-mapping.js';
import type { RepoChatMapping } from './types.js';

const DATA_DIR = path.resolve(import.meta.dirname, '..', 'data');
const REPO_MAPPING_FILE = path.join(DATA_DIR, 'repo-chat-mapping.json');

function requiredEnv(n: string): string {
  const v = process.env[n];
  if (!v) throw new Error(`Required env var ${n} is not set`);
  return v;
}

function loadRepoMapping(): RepoChatMapping {
  if (!fs.existsSync(REPO_MAPPING_FILE)) return {};
  return JSON.parse(fs.readFileSync(REPO_MAPPING_FILE, 'utf-8'));
}

async function main() {
  const config = loadConfig();
  initLarkClient(config);
  const octokit = new Octokit({ auth: config.githubToken });

  const event = JSON.parse(fs.readFileSync(requiredEnv('GITHUB_EVENT_PATH'), 'utf-8'));
  const p = event.client_payload ?? {};
  const login: string = p.login;
  if (!login) throw new Error(`Malformed client_payload (no login): ${JSON.stringify(p)}`);

  console.log(`Member joined: @${login} → ${config.githubOrg}`);

  const userMapping = loadUserMapping();
  let openId = larkIdForGithub(userMapping, login);

  // Not matched yet? Try email + name resolution against the current Lark dept.
  if (!openId) {
    console.log('Not in user-mapping; attempting fresh match…');
    try {
      const { data: profile } = await octokit.users.getByUsername({ username: login });
      const ghEmail = profile.email?.toLowerCase();
      if (ghEmail) {
        const larkMembers = await listDepartmentMembersDetailed(config.larkSourceDepartmentId);
        const byEmail = larkMembers.find(
          (m) => m.email && m.email.toLowerCase() === ghEmail,
        );
        if (byEmail) {
          console.log(`  email match: ${ghEmail} → ${byEmail.name} (${byEmail.open_id})`);
          recordMatch(userMapping, login, {
            lark_open_id: byEmail.open_id,
            lark_name: byEmail.name,
            email: byEmail.email ?? undefined,
            decided_by: 'auto:member-joined',
          });
          saveUserMapping(userMapping);
          openId = byEmail.open_id;
        }
      }
      // Fuzzy name match could also go here, but the next scheduled
      // sync-members run will handle it with a better algorithm.
    } catch (err) {
      console.warn(`  could not resolve identity: ${err}`);
    }
  }

  if (!openId) {
    console.log(`@${login} has no Lark mapping yet — will be picked up by the next sync-members run.`);
    return;
  }

  // Find every repo in the org where @login is a contributor or PR author,
  // and add them to that repo's chat.
  const repoMapping = loadRepoMapping();
  let added = 0, skipped = 0, errors = 0;

  for (const [fullName, entry] of Object.entries(repoMapping)) {
    const [owner, repoName] = fullName.split('/');
    if (owner !== config.githubOrg) continue;

    let isContributor = false;
    try {
      const { data: contributors } = await octokit.repos.listContributors({
        owner, repo: repoName, per_page: 100,
      });
      if (contributors.some((c) => c.login === login && c.type === 'User')) {
        isContributor = true;
      }
    } catch {
      // Empty repo — skip
    }

    if (!isContributor) {
      try {
        const prs = await octokit.paginate(octokit.pulls.list, {
          owner, repo: repoName, state: 'all', per_page: 100,
        });
        if (prs.some((pr) => pr.user?.login === login)) {
          isContributor = true;
        }
      } catch {
        // Ignore
      }
    }

    if (!isContributor) {
      skipped++;
      continue;
    }

    try {
      await addMembersToChat(entry.chat_id, [openId]);
      added++;
      console.log(`  + added @${login} to chat for ${fullName}`);
    } catch (err) {
      errors++;
      console.warn(`  ⚠ could not add to ${fullName}: ${err}`);
    }
  }

  console.log(`\nSummary: added to ${added} chat(s), skipped ${skipped} (not a contributor), ${errors} error(s).`);
}

main().catch((err) => {
  console.error('Fatal error:', formatLarkError(err));
  process.exit(1);
});
