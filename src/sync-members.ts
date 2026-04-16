/**
 * Bidirectional member sync: Lark department ↔ GitHub organization.
 *
 * Source of truth: the configured Lark department.
 *
 * Flow:
 *   1. Fetch members of the Lark source department (with emails)
 *   2. Fetch current GitHub org members (with emails)
 *   3. Match by email
 *   4. Lark members NOT in GitHub → invite to GitHub org
 *   5. GitHub members NOT in Lark dept → optionally remove from GitHub org
 *   6. Ensure all matched GitHub members are in the sync Lark department
 */

import { Octokit } from '@octokit/rest';
import { loadConfig } from './config.js';
import {
  initLarkClient,
  listDepartmentMembersDetailed,
  getOrCreateDepartment,
  listDepartmentMembers,
  batchGetUserIdsByEmail,
  getLarkClient,
} from './lark.js';
import type { GitHubMember, LarkMember, MemberSyncResult } from './types.js';

async function fetchGitHubMembers(octokit: Octokit, org: string): Promise<GitHubMember[]> {
  const members: GitHubMember[] = [];

  for await (const response of octokit.paginate.iterator(octokit.orgs.listMembers, {
    org,
    per_page: 100,
  })) {
    for (const member of response.data) {
      const { data: profile } = await octokit.users.getByUsername({
        username: member.login,
      });
      members.push({
        login: member.login,
        email: profile.email ?? null,
        avatar_url: member.avatar_url,
        html_url: member.html_url,
      });
    }
  }

  return members;
}

/** Also fetch pending invitations so we don't re-invite. */
async function fetchPendingInvitations(octokit: Octokit, org: string): Promise<Set<string>> {
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
  console.log(`=== Bidirectional Sync: Lark dept(${deptId}) ↔ GitHub org(${config.githubOrg}) ===\n`);

  // 1. Fetch Lark department members
  console.log('1. Fetching Lark department members...');
  const larkMembers = await listDepartmentMembersDetailed(deptId);
  const larkWithEmail = larkMembers.filter((m) => m.email);
  console.log(`   ${larkMembers.length} total, ${larkWithEmail.length} with email\n`);

  // 2. Fetch GitHub org members
  console.log('2. Fetching GitHub org members...');
  const ghMembers = await fetchGitHubMembers(octokit, config.githubOrg);
  const ghWithEmail = ghMembers.filter((m) => m.email);
  console.log(`   ${ghMembers.length} total, ${ghWithEmail.length} with email\n`);

  // 3. Fetch pending GitHub invitations
  console.log('3. Checking pending invitations...');
  const pendingInvites = await fetchPendingInvitations(octokit, config.githubOrg);
  console.log(`   ${pendingInvites.size} pending\n`);

  // 4. Build email indexes
  const larkEmailMap = new Map<string, LarkMember>(); // email → LarkMember
  for (const m of larkWithEmail) {
    larkEmailMap.set(m.email!.toLowerCase(), m);
  }

  const ghEmailMap = new Map<string, GitHubMember>(); // email → GitHubMember
  for (const m of ghWithEmail) {
    ghEmailMap.set(m.email!.toLowerCase(), m);
  }

  // 5. Determine who to invite / remove
  // Lark members with email not in GitHub → invite
  const toInvite: Array<{ email: string; name: string }> = [];
  for (const [email, lm] of larkEmailMap) {
    if (!ghEmailMap.has(email) && !pendingInvites.has(email)) {
      toInvite.push({ email, name: lm.name });
    }
  }

  // GitHub members with email not in Lark dept → remove
  const toRemove: Array<{ login: string; email: string }> = [];
  if (config.syncRemoveMembers) {
    for (const [email, gm] of ghEmailMap) {
      if (!larkEmailMap.has(email)) {
        toRemove.push({ login: gm.login, email });
      }
    }
  }

  const alreadySynced = [...larkEmailMap.keys()].filter((e) => ghEmailMap.has(e));

  console.log('4. Sync plan:');
  console.log(`   Already synced: ${alreadySynced.length}`);
  console.log(`   To invite to GitHub: ${toInvite.length}`);
  console.log(`   To remove from GitHub: ${toRemove.length}`);

  const larkNoEmail = larkMembers.filter((m) => !m.email);
  const ghNoEmail = ghMembers.filter((m) => !m.email);
  const unmatchable = larkNoEmail.length + ghNoEmail.length;
  if (unmatchable > 0) {
    console.log(`   Unmatchable (no email): ${larkNoEmail.length} Lark + ${ghNoEmail.length} GitHub`);
  }
  console.log();

  // 6. Apply changes
  const result: MemberSyncResult = {
    invited: [],
    removed: [],
    alreadySynced: alreadySynced.map((e) => larkEmailMap.get(e)?.name ?? e),
    unmatchable: [
      ...larkNoEmail.map((m) => `Lark:${m.name}`),
      ...ghNoEmail.map((m) => `GitHub:${m.login}`),
    ],
    errors: [],
  };

  if (config.dryRun) {
    console.log('5. DRY RUN — no changes applied');
    if (toInvite.length > 0) {
      console.log('   Would invite:');
      for (const u of toInvite) console.log(`     + ${u.name} (${u.email})`);
    }
    if (toRemove.length > 0) {
      console.log('   Would remove:');
      for (const u of toRemove) console.log(`     - ${u.login} (${u.email})`);
    }
  } else {
    console.log('5. Applying changes...');

    // Invite Lark members to GitHub org
    for (const u of toInvite) {
      try {
        await octokit.orgs.createInvitation({
          org: config.githubOrg,
          email: u.email,
          role: 'direct_member',
        });
        result.invited.push(`${u.name} (${u.email})`);
        console.log(`   + Invited ${u.name} (${u.email})`);
      } catch (err) {
        result.errors.push(`Invite ${u.email}: ${err}`);
        console.error(`   x Failed to invite ${u.email}: ${err}`);
      }
    }

    // Remove GitHub members not in Lark dept
    for (const u of toRemove) {
      try {
        await octokit.orgs.removeMembershipForUser({
          org: config.githubOrg,
          username: u.login,
        });
        result.removed.push(`${u.login} (${u.email})`);
        console.log(`   - Removed ${u.login} (${u.email})`);
      } catch (err) {
        result.errors.push(`Remove ${u.login}: ${err}`);
        console.error(`   x Failed to remove ${u.login}: ${err}`);
      }
    }
  }

  // Summary
  console.log('\n=== Summary ===');
  console.log(`Synced:      ${result.alreadySynced.length}`);
  console.log(`Invited:     ${result.invited.length}`);
  console.log(`Removed:     ${result.removed.length}`);
  console.log(`Unmatchable: ${result.unmatchable.length}`);
  console.log(`Errors:      ${result.errors.length}`);

  if (result.errors.length > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
