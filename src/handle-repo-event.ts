/**
 * Handle a single GitHub repository lifecycle event dispatched from the
 * centralized Worker (via `repository_dispatch: repo-changed`).
 *
 * Expected client_payload:
 *   { action: "created" | "deleted" | "renamed" | "archived" | "unarchived",
 *     full_name, id, html_url, default_branch, private, description,
 *     old_name? }
 */

import fs from 'node:fs';
import path from 'node:path';
import { Octokit } from '@octokit/rest';
import { loadConfig } from './config.js';
import {
  initLarkClient,
  listBotChats,
  formatLarkError,
} from './lark.js';
import {
  ensureRepoChat,
  findMappingEntry,
  pushNotifyWorkflow,
  renameRepoChat,
  repoMemberOpenIds,
  sendRepoArchivedNotice,
  sendRepoDeletedNotice,
} from './repos.js';
import { loadUserMapping } from './user-mapping.js';
import type { GitHubRepo, RepoChatMapping } from './types.js';

const DATA_DIR = path.resolve(import.meta.dirname, '..', 'data');
const MAPPING_FILE = path.join(DATA_DIR, 'repo-chat-mapping.json');

function loadMapping(): RepoChatMapping {
  if (!fs.existsSync(MAPPING_FILE)) return {};
  return JSON.parse(fs.readFileSync(MAPPING_FILE, 'utf-8'));
}
function saveMapping(m: RepoChatMapping) {
  fs.writeFileSync(MAPPING_FILE, JSON.stringify(m, null, 2) + '\n');
}

function requiredEnv(n: string): string {
  const v = process.env[n];
  if (!v) throw new Error(`Required env var ${n} is not set`);
  return v;
}

async function main() {
  const config = loadConfig();
  initLarkClient(config);
  const octokit = new Octokit({ auth: config.githubToken });

  const event = JSON.parse(fs.readFileSync(requiredEnv('GITHUB_EVENT_PATH'), 'utf-8'));
  const p = event.client_payload ?? {};
  const syncRepoFullName = process.env.GITHUB_REPOSITORY ?? `${config.githubOrg}/feishu-github-sync`;

  const action: string = p.action;
  const fullName: string = p.full_name;
  const repoId: number = p.id;
  const htmlUrl: string = p.html_url ?? `https://github.com/${fullName}`;

  if (!action || !fullName) {
    throw new Error(`Malformed client_payload: ${JSON.stringify(p)}`);
  }

  console.log(`Repo event: ${action} ${fullName} (id=${repoId})`);

  if (fullName === syncRepoFullName) {
    console.log('  (ignoring event for the sync repo itself)');
    return;
  }

  const mapping = loadMapping();
  const repoName = fullName.split('/').pop() ?? fullName;

  switch (action) {
    case 'created': {
      const repo: GitHubRepo & { id: number } = {
        name: repoName,
        full_name: fullName,
        description: p.description ?? null,
        html_url: htmlUrl,
        private: p.private ?? false,
        default_branch: p.default_branch ?? 'main',
        id: repoId,
      };
      const existingChats = await listBotChats();
      const adminOpenId = process.env.LARK_ADMIN_OPEN_ID || '';
      const userMapping = loadUserMapping();
      const contributors = await repoMemberOpenIds(octokit, config.githubOrg, repoName, userMapping);
      const memberOpenIds = [...(adminOpenId ? [adminOpenId] : []), ...contributors];

      const r = await ensureRepoChat(octokit, repo, mapping, existingChats, {
        owner: config.githubOrg,
        dryRun: config.dryRun,
        memberOpenIds,
      });
      console.log(`  ${r.created ? '+ created' : '~ reused'} chat ${r.chat_id} (${memberOpenIds.length} initial members)`);

      // Push the notify workflow so events start flowing immediately
      try {
        const status = await pushNotifyWorkflow(
          octokit,
          config.githubOrg,
          repoName,
          repo.default_branch,
          syncRepoFullName,
          { dryRun: config.dryRun },
        );
        console.log(`  workflow: ${status}`);
      } catch (err) {
        console.warn(`  ⚠ could not push notify workflow: ${err}`);
      }
      break;
    }

    case 'renamed': {
      const oldName: string = p.old_name ?? '';
      const oldFullName = oldName ? `${config.githubOrg}/${oldName}` : '';
      const entry =
        findMappingEntry(mapping, { full_name: fullName, id: repoId }) ??
        (oldFullName ? findMappingEntry(mapping, { full_name: oldFullName, id: repoId }) : null);

      if (!entry) {
        console.log('  no mapping entry — treating as "created"');
        const repo: GitHubRepo & { id: number } = {
          name: repoName,
          full_name: fullName,
          description: p.description ?? null,
          html_url: htmlUrl,
          private: p.private ?? false,
          default_branch: p.default_branch ?? 'main',
          id: repoId,
        };
        const existingChats = await listBotChats();
        const adminOpenId = process.env.LARK_ADMIN_OPEN_ID || '';
        const userMapping = loadUserMapping();
        const contributors = await repoMemberOpenIds(octokit, config.githubOrg, repoName, userMapping);
        const memberOpenIds = [...(adminOpenId ? [adminOpenId] : []), ...contributors];

        await ensureRepoChat(octokit, repo, mapping, existingChats, {
          owner: config.githubOrg,
          dryRun: config.dryRun,
          memberOpenIds,
        });
      } else {
        // Migrate mapping key + rename the Lark chat
        if (entry.key !== fullName) {
          entry.entry.renames = entry.entry.renames ?? [];
          if (!entry.entry.renames.includes(entry.key)) entry.entry.renames.push(entry.key);
          delete mapping[entry.key];
          mapping[fullName] = entry.entry;
        }
        mapping[fullName].chat_name = `GitHub: ${fullName}`;
        if (repoId) mapping[fullName].repo_id = repoId;
        if (!config.dryRun) {
          try {
            await renameRepoChat(mapping[fullName].chat_id, fullName, htmlUrl, oldFullName || entry.key);
            console.log(`  ✏️ renamed chat ${mapping[fullName].chat_id}`);
          } catch (err) {
            console.warn(`  ⚠ could not rename chat: ${err}`);
          }
        }
      }
      break;
    }

    case 'archived': {
      const entry = findMappingEntry(mapping, { full_name: fullName, id: repoId });
      if (!entry) { console.log('  no mapping entry — nothing to do'); break; }
      entry.entry.archived = true;
      if (!config.dryRun) {
        try {
          await sendRepoArchivedNotice(entry.entry.chat_id, fullName, htmlUrl);
        } catch (err) {
          console.warn(`  ⚠ could not post archived notice: ${err}`);
        }
      }
      console.log(`  📦 marked ${fullName} archived`);
      break;
    }

    case 'unarchived': {
      const entry = findMappingEntry(mapping, { full_name: fullName, id: repoId });
      if (!entry) { console.log('  no mapping entry — nothing to do'); break; }
      entry.entry.archived = false;
      console.log(`  📦 unarchived ${fullName}`);
      break;
    }

    case 'deleted': {
      const entry = findMappingEntry(mapping, { full_name: fullName, id: repoId });
      if (!entry) { console.log('  no mapping entry — nothing to do'); break; }
      if (!config.dryRun) {
        try {
          await sendRepoDeletedNotice(entry.entry.chat_id, fullName);
        } catch (err) {
          console.warn(`  ⚠ could not post deleted notice: ${err}`);
        }
      }
      delete mapping[entry.key];
      console.log(`  🗑️ removed mapping for ${fullName}`);
      break;
    }

    default:
      console.warn(`Unhandled action: ${action}`);
  }

  if (!config.dryRun) {
    saveMapping(mapping);
    console.log('  mapping saved');
  }
}

main().catch((err) => {
  console.error('Fatal error:', formatLarkError(err));
  process.exit(1);
});
