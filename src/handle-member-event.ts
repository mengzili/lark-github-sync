/**
 * Handle a `member-joined` event dispatched by the Worker when someone
 * accepts the GitHub org invitation.
 *
 * Flow:
 *   1. Load user-mapping. If the new member isn't matched yet, try to
 *      resolve them now:
 *        a. Exact email match (profile email or commit-author probe)
 *        b. Fuzzy name match (pinyin-aware) — auto-link ≥0.95 unambiguous
 *        c. Otherwise append to pending[] and post an approval card
 *   2. If matched (now or previously), find every repo in the org that
 *      lists them as a contributor (commits or PR authorship) and add
 *      their Lark open_id to each repo's chat.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Octokit } from '@octokit/rest';
import { loadConfig } from './config.js';
import {
  initLarkClient,
  addMembersToChat,
  listDepartmentMembersDetailed,
  sendCardMessage,
  formatLarkError,
} from './lark.js';
import {
  loadUserMapping,
  saveUserMapping,
  recordMatch,
  addPending,
  larkIdForGithub,
  isPending,
} from './user-mapping.js';
import { AUTO_MATCH_THRESHOLD, bestMatches } from './name-match.js';
import { approvalPromptCard } from './cards.js';
import type { LarkMember, MatchCandidate, PendingApproval, RepoChatMapping } from './types.js';

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

  // Not matched yet? Try to resolve them before the next scheduled sync.
  if (!openId) {
    console.log('Not in user-mapping; attempting fresh match…');
    try {
      const [profile, larkMembers] = await Promise.all([
        octokit.users.getByUsername({ username: login }).then((r) => r.data),
        listDepartmentMembersDetailed(config.larkSourceDepartmentId),
      ]);

      // a. Exact email match (profile email)
      const ghEmail = profile.email?.toLowerCase();
      let match: LarkMember | undefined;
      if (ghEmail) {
        match = larkMembers.find((m) => m.email?.toLowerCase() === ghEmail);
        if (match) console.log(`  email match: ${ghEmail} → ${match.name}`);
      }

      // b. Commit-author email probe
      if (!match) {
        try {
          const res = await octokit.search.commits({
            q: `author:${login} org:${config.githubOrg}`,
            per_page: 5,
          });
          const emails = new Set<string>();
          for (const c of res.data.items) {
            const e = (c as any).commit?.author?.email as string | undefined;
            if (e && !e.endsWith('@users.noreply.github.com')) emails.add(e.toLowerCase());
          }
          for (const email of emails) {
            const m = larkMembers.find((x) => x.email?.toLowerCase() === email);
            if (m) { match = m; console.log(`  commit-email match: ${email} → ${m.name}`); break; }
          }
        } catch {}
      }

      // c. Fuzzy name match (pinyin-aware, surname-order-tolerant)
      if (!match) {
        const ghName = profile.name || login.replace(/[-_]/g, ' ');
        const pool = larkMembers.map((l) => ({ name: l.name, member: l }));
        const candidates = bestMatches(ghName, pool, 3);
        if (candidates.length > 0) {
          const top = candidates[0];
          const unambiguous =
            candidates.length === 1 || candidates[1].score < AUTO_MATCH_THRESHOLD;
          if (top.score >= AUTO_MATCH_THRESHOLD && unambiguous) {
            match = top.item.member;
            console.log(`  fuzzy auto-match: "${ghName}" → ${match.name} (${top.score.toFixed(2)})`);
          } else {
            // Post as pending for admin approval
            const matchCandidates: MatchCandidate[] = candidates.map((c) => ({
              lark_open_id: c.item.member.open_id,
              lark_name: c.item.member.name,
              email: c.item.member.email ?? undefined,
              score: Number(c.score.toFixed(3)),
            }));
            const pending: PendingApproval = {
              gh_login: login,
              gh_name: profile.name ?? undefined,
              gh_email: profile.email ?? undefined,
              gh_avatar_url: p.avatar_url ?? profile.avatar_url,
              candidates: matchCandidates,
              posted_at: new Date().toISOString(),
            };
            if (!isPending(userMapping, login)) {
              addPending(userMapping, pending);
              saveUserMapping(userMapping);
              console.log(`  no confident match — added to pending (${candidates.length} candidates)`);

              // Post approval card to admin chat
              const adminChat = process.env.LARK_ADMIN_CHAT_ID || '';
              const approveBase =
                process.env.APPROVE_URL_BASE ??
                'https://zilimeng.com/lark-github-sync';
              if (adminChat) {
                try {
                  await sendCardMessage(
                    adminChat,
                    approvalPromptCard({
                      count: Object.keys(userMapping.pending).length,
                      org: config.githubOrg,
                      approveUrl: `${approveBase}/approve.html#org=${encodeURIComponent(config.githubOrg)}`,
                      sampleLogins: Object.keys(userMapping.pending),
                    }) as any,
                  );
                  console.log('  posted approval card to admin chat');
                } catch (err) {
                  console.warn(`  ⚠ could not post approval card: ${err}`);
                }
              }
            }
          }
        }
      }

      if (match) {
        recordMatch(userMapping, login, {
          lark_open_id: match.open_id,
          lark_name: match.name,
          email: match.email ?? profile.email ?? undefined,
          decided_by: 'auto:member-joined',
        });
        saveUserMapping(userMapping);
        openId = match.open_id;
      }
    } catch (err) {
      console.warn(`  could not resolve identity: ${err}`);
    }
  }

  if (!openId) {
    console.log(`@${login} has no confident Lark mapping — awaiting approval.`);
    return;
  }

  // Find every repo where @login is a contributor or PR author, and add
  // them to that repo's chat.
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
    } catch {}

    if (!isContributor) {
      try {
        const prs = await octokit.paginate(octokit.pulls.list, {
          owner, repo: repoName, state: 'all', per_page: 100,
        });
        if (prs.some((pr) => pr.user?.login === login)) isContributor = true;
      } catch {}
    }

    if (!isContributor) { skipped++; continue; }

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

