/**
 * Two-way member sync: Lark department ↔ GitHub organization.
 *
 * Matching strategy (applied in order):
 *   1. Exact email match (profile email or enterprise email on either side).
 *   2. Commit-author email probe for GitHub users with no public email.
 *   3. Fuzzy name match (pinyin-aware, CJK-friendly) — auto-link ≥0.95.
 *   4. Ambiguous matches (0.70–0.95) → posted to admin chat for one-click
 *      approval via docs/approve.html. Decisions persist in
 *      data/user-mapping.json so re-runs never re-ask.
 *
 * Existing resolved mappings are honored (matched or skipped).
 */

import { Octokit } from '@octokit/rest';
import { loadConfig } from './config.js';
import {
  initLarkClient,
  listDepartmentMembersDetailed,
  sendCardMessage,
  formatLarkError,
} from './lark.js';
import { approvalPromptCard } from './cards.js';
import {
  addPending,
  isPending,
  isResolved,
  loadUserMapping,
  recordMatch,
  saveUserMapping,
} from './user-mapping.js';
import {
  AUTO_MATCH_THRESHOLD,
  bestMatches,
} from './name-match.js';
import type {
  GitHubMember,
  LarkMember,
  MatchCandidate,
  MemberSyncResult,
  PendingApproval,
} from './types.js';

/** GitHub profile + commit-email probe for a single login. */
async function fetchGitHubMember(
  octokit: Octokit,
  org: string,
  login: string,
  avatar_url: string,
  html_url: string,
): Promise<GitHubMember & { commit_emails: string[]; name?: string | null }> {
  const { data: profile } = await octokit.users.getByUsername({ username: login });

  // Probe recent commits to recover a work email when profile.email is empty.
  // We scan up to 10 recent commits across the org — stop as soon as we find a
  // non-noreply email.
  const commit_emails: string[] = [];
  try {
    for await (const response of octokit.paginate.iterator(octokit.search.commits, {
      q: `author:${login} org:${org}`,
      per_page: 10,
    })) {
      for (const c of response.data) {
        const email = (c as any).commit?.author?.email as string | undefined;
        if (email && !email.endsWith('@users.noreply.github.com')) {
          commit_emails.push(email.toLowerCase());
        }
      }
      if (commit_emails.length > 0) break;
    }
  } catch {
    // commit search has strict rate limits and requires auth — silently ignore
  }

  return {
    login,
    email: profile.email ?? null,
    avatar_url,
    html_url,
    name: profile.name,
    commit_emails: [...new Set(commit_emails)],
  };
}

async function fetchGitHubMembers(
  octokit: Octokit,
  org: string,
): Promise<Array<GitHubMember & { commit_emails: string[]; name?: string | null }>> {
  const members: Array<GitHubMember & { commit_emails: string[]; name?: string | null }> = [];
  for await (const response of octokit.paginate.iterator(octokit.orgs.listMembers, {
    org,
    per_page: 100,
  })) {
    for (const m of response.data) {
      members.push(
        await fetchGitHubMember(octokit, org, m.login, m.avatar_url, m.html_url),
      );
    }
  }
  return members;
}

/** Also fetch pending invitations so we don't re-invite. */
async function fetchPendingInvitations(
  octokit: Octokit,
  org: string,
): Promise<Set<string>> {
  const emails = new Set<string>();
  try {
    for await (const response of octokit.paginate.iterator(
      octokit.orgs.listPendingInvitations,
      { org, per_page: 100 },
    )) {
      for (const inv of response.data) {
        if (inv.email) emails.add(inv.email.toLowerCase());
      }
    }
  } catch {
    // May not have permission — that's okay
  }
  return emails;
}

async function main() {
  const config = loadConfig();
  initLarkClient(config);
  const octokit = new Octokit({ auth: config.githubToken });

  const deptId = config.larkSourceDepartmentId;
  const adminChatId = process.env.LARK_ADMIN_CHAT_ID ?? '';
  const approveBase =
    process.env.APPROVE_URL_BASE ??
    'https://zilimeng.com/lark-github-sync';
  const approveUrl = `${approveBase}/approve.html#org=${encodeURIComponent(config.githubOrg)}`;

  console.log(
    `=== Two-way sync: Lark dept(${deptId}) ↔ GitHub org(${config.githubOrg}) ===\n`,
  );

  const mapping = loadUserMapping();

  console.log('1. Fetching Lark department members...');
  const larkMembers = await listDepartmentMembersDetailed(deptId);
  console.log(`   ${larkMembers.length} total\n`);

  console.log('2. Fetching GitHub org members (+commit email probe)...');
  const ghMembers = await fetchGitHubMembers(octokit, config.githubOrg);
  console.log(`   ${ghMembers.length} total\n`);

  console.log('3. Checking pending invitations...');
  const pendingInvites = await fetchPendingInvitations(octokit, config.githubOrg);
  console.log(`   ${pendingInvites.size} pending\n`);

  // ── Step 4: Exact email match (primary path) ──────────────────────────
  const larkByEmail = new Map<string, LarkMember>();
  for (const m of larkMembers) {
    if (m.email) larkByEmail.set(m.email.toLowerCase(), m);
  }
  const ghByLogin = new Map<string, GitHubMember>();
  const ghByEmail = new Map<string, GitHubMember>();
  for (const m of ghMembers) {
    ghByLogin.set(m.login, m);
    if (m.email) ghByEmail.set(m.email.toLowerCase(), m);
    for (const ce of m.commit_emails) ghByEmail.set(ce, m);
  }

  const matchedLark = new Set<string>(); // open_ids
  const matchedGh = new Set<string>(); // logins

  // Pass 1: exact email
  for (const [email, lark] of larkByEmail) {
    const gh = ghByEmail.get(email);
    if (gh) {
      matchedLark.add(lark.open_id);
      matchedGh.add(gh.login);
      // Remember the link for @-mentions (auto, stable)
      if (!isResolved(mapping, gh.login)) {
        recordMatch(mapping, gh.login, {
          lark_open_id: lark.open_id,
          lark_name: lark.name,
          email,
          decided_by: 'auto:email',
        });
      }
    }
  }

  // Pass 2: honor any previously resolved mappings (matched or skipped)
  for (const gh of ghMembers) {
    const entry = mapping.entries[gh.login];
    if (!entry) continue;
    matchedGh.add(gh.login);
    if (entry.status === 'matched' && entry.lark_open_id) {
      matchedLark.add(entry.lark_open_id);
    }
  }

  // ── Step 5: Fuzzy name match on the remainder ─────────────────────────
  const unmatchedLark = larkMembers.filter((m) => !matchedLark.has(m.open_id));
  const unmatchedGh = ghMembers.filter((m) => !matchedGh.has(m.login));

  console.log(
    `4. Matching: ${matchedGh.size} by email+history, ${unmatchedGh.length} GitHub / ${unmatchedLark.length} Lark remaining\n`,
  );

  const larkPool = unmatchedLark.map((l) => ({ name: l.name, member: l }));

  // Pass 1 — compute candidates for every unmatched GitHub user.
  type ScoredGh = {
    gh: typeof unmatchedGh[number];
    matches: Array<{ item: { name: string; member: LarkMember }; score: number }>;
  };
  const scored: ScoredGh[] = [];
  for (const gh of unmatchedGh) {
    if (isResolved(mapping, gh.login) || isPending(mapping, gh.login)) continue;
    const ghName = gh.name || gh.login.replace(/[-_]/g, ' ');
    const matches = bestMatches(ghName, larkPool, 3);
    if (matches.length === 0) continue;
    scored.push({ gh, matches });
  }

  // Pass 2 — detect collisions where multiple GitHub users have the same
  // Lark user as their top candidate. Auto-match requires uniqueness.
  const topContestCount = new Map<string, number>();
  for (const s of scored) {
    const topId = s.matches[0].item.member.open_id;
    topContestCount.set(topId, (topContestCount.get(topId) ?? 0) + 1);
  }

  const newPending: PendingApproval[] = [];
  let autoLinked = 0;

  for (const { gh, matches } of scored) {
    const top = matches[0];
    const topUnique = (topContestCount.get(top.item.member.open_id) ?? 0) === 1;
    const topHighEnough = top.score >= AUTO_MATCH_THRESHOLD;
    const unambiguous = matches.length === 1 || matches[1].score < AUTO_MATCH_THRESHOLD;

    if (topHighEnough && topUnique && unambiguous) {
      recordMatch(mapping, gh.login, {
        lark_open_id: top.item.member.open_id,
        lark_name: top.item.member.name,
        email: top.item.member.email ?? gh.email ?? undefined,
        decided_by: 'auto:name',
      });
      matchedLark.add(top.item.member.open_id);
      matchedGh.add(gh.login);
      autoLinked++;
      console.log(
        `   ~ auto-linked ${gh.login} → ${top.item.member.name} (score ${top.score.toFixed(2)})`,
      );
    } else {
      const candidates: MatchCandidate[] = matches.map((m) => ({
        lark_open_id: m.item.member.open_id,
        lark_name: m.item.member.name,
        email: m.item.member.email ?? undefined,
        score: Number(m.score.toFixed(3)),
      }));
      const approval: PendingApproval = {
        gh_login: gh.login,
        gh_name: gh.name ?? undefined,
        gh_email: gh.email ?? gh.commit_emails[0] ?? undefined,
        gh_avatar_url: gh.avatar_url,
        candidates,
        posted_at: new Date().toISOString(),
      };
      addPending(mapping, approval);
      newPending.push(approval);
    }
  }

  // ── Step 6: Compute invites (never remove) ────────────────────────────
  //
  // We deliberately DO NOT remove GitHub org members, even when they're not
  // in the Lark department. Lark ↔ GitHub matching can miss people (email
  // differences, unmatched contributors who've contributed via SSO, etc.) and
  // the cost of a false positive is high — a contributor loses access and
  // their PR history gets "Unknown User" ghosts. The admin can still remove
  // people manually in GitHub if needed.
  const toInvite: Array<{ email: string; name: string }> = [];
  for (const lark of larkMembers) {
    if (!lark.email) continue;
    if (matchedLark.has(lark.open_id)) continue;
    if (pendingInvites.has(lark.email.toLowerCase())) continue;
    toInvite.push({ email: lark.email, name: lark.name });
  }

  console.log('5. Sync plan:');
  console.log(`   Matched (all sources): ${matchedGh.size}`);
  console.log(`   Auto name-matched:     ${autoLinked}`);
  console.log(`   To invite to GitHub:   ${toInvite.length}`);
  console.log(`   Awaiting approval:     ${Object.keys(mapping.pending).length} (${newPending.length} new)`);
  console.log();

  const result: MemberSyncResult = {
    invited: [],
    removed: [],
    alreadySynced: [...matchedGh],
    unmatchable: [],
    errors: [],
  };

  if (config.dryRun) {
    console.log('6. DRY RUN — no changes applied');
    if (toInvite.length) {
      console.log('   Would invite:');
      for (const u of toInvite) console.log(`     + ${u.name} (${u.email})`);
    }
    if (newPending.length) {
      console.log('   Would flag for approval:');
      for (const p of newPending) console.log(`     ? ${p.gh_login} (${p.candidates.length} candidates)`);
    }
  } else {
    console.log('6. Applying changes...');

    for (const u of toInvite) {
      try {
        await octokit.orgs.createInvitation({
          org: config.githubOrg,
          email: u.email,
          role: 'direct_member',
        });
        result.invited.push(`${u.name} (${u.email})`);
        console.log(`   + invited ${u.name} (${u.email})`);
      } catch (err) {
        result.errors.push(`Invite ${u.email}: ${err}`);
        console.error(`   x failed to invite ${u.email}: ${err}`);
      }
    }

    saveUserMapping(mapping);
    console.log(`   wrote data/user-mapping.json`);

    // Post one approval-prompt card if there's anything new pending and an
    // admin chat is configured.
    if (newPending.length > 0 && adminChatId) {
      try {
        await sendCardMessage(
          adminChatId,
          approvalPromptCard({
            count: Object.keys(mapping.pending).length,
            org: config.githubOrg,
            approveUrl,
            sampleLogins: Object.keys(mapping.pending),
          }) as any,
        );
        console.log(`   posted approval card to admin chat`);
      } catch (err) {
        result.errors.push(`Approval card: ${err}`);
        console.warn(`   ⚠ failed to post approval card: ${formatLarkError(err)}`);
      }
    } else if (newPending.length > 0) {
      console.warn(
        `   ⚠ ${newPending.length} new pending, but LARK_ADMIN_CHAT_ID is unset — skipping card`,
      );
    }
  }

  console.log('\n=== Summary ===');
  console.log(`Matched:          ${matchedGh.size}`);
  console.log(`Invited:          ${result.invited.length}`);
  console.log(`Pending approval: ${Object.keys(mapping.pending).length}`);
  console.log(`Errors:           ${result.errors.length}`);

  if (result.errors.length) process.exit(1);
}

main().catch((err) => {
  console.error('Fatal error:', formatLarkError(err));
  process.exit(1);
});
