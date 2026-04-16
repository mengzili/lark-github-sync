/**
 * Sync GitHub organization members → Lark department.
 *
 * Flow:
 *   1. Fetch GitHub org members (with emails where available)
 *   2. Load optional manual user-mapping overrides
 *   3. Get-or-create the target Lark department
 *   4. Resolve GitHub emails → Lark open_ids
 *   5. Add new members / remove departed members
 */

import { Octokit } from '@octokit/rest';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import {
  initLarkClient,
  getOrCreateDepartment,
  batchGetUserIdsByEmail,
  listDepartmentMembers,
} from './lark.js';
import type { GitHubMember, MemberSyncResult, UserMapping } from './types.js';

const DATA_DIR = path.resolve(import.meta.dirname, '..', 'data');

async function fetchOrgMembers(octokit: Octokit, org: string): Promise<GitHubMember[]> {
  const members: GitHubMember[] = [];

  for await (const response of octokit.paginate.iterator(octokit.orgs.listMembers, {
    org,
    per_page: 100,
  })) {
    for (const member of response.data) {
      // Fetch per-user profile for email (list endpoint doesn't include it)
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

function loadUserMapping(): UserMapping {
  const filePath = path.join(DATA_DIR, 'user-mapping.json');
  if (!fs.existsSync(filePath)) return {};
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function resolveEmails(
  members: GitHubMember[],
  userMapping: UserMapping,
): Map<string, string> {
  // Map: GitHub login → resolved email
  const result = new Map<string, string>();

  for (const m of members) {
    // Manual mapping takes priority
    if (userMapping[m.login]) {
      result.set(m.login, userMapping[m.login]);
    } else if (m.email) {
      result.set(m.login, m.email);
    }
  }
  return result;
}

async function main() {
  const config = loadConfig();
  initLarkClient(config);
  const octokit = new Octokit({ auth: config.githubToken });

  console.log(`=== Member Sync: ${config.githubOrg} → Lark "${config.larkDepartmentName}" ===\n`);

  // 1. Fetch GitHub org members
  console.log('1. Fetching GitHub org members...');
  const ghMembers = await fetchOrgMembers(octokit, config.githubOrg);
  console.log(`   Found ${ghMembers.length} members\n`);

  // 2. Load manual user-mapping overrides
  const userMapping = loadUserMapping();
  const overrideCount = Object.keys(userMapping).length;
  if (overrideCount > 0) {
    console.log(`   Loaded ${overrideCount} manual email overrides from user-mapping.json`);
  }

  // 3. Resolve emails
  const loginToEmail = resolveEmails(ghMembers, userMapping);
  const unmapped = ghMembers.filter((m) => !loginToEmail.has(m.login));
  if (unmapped.length > 0) {
    console.log(`   ⚠ ${unmapped.length} member(s) have no resolvable email:`);
    for (const m of unmapped) {
      console.log(`     - ${m.login} (add to data/user-mapping.json)`);
    }
    console.log();
  }

  // 4. Get-or-create Lark department
  console.log(`2. Ensuring Lark department "${config.larkDepartmentName}" exists...`);
  const deptId = await getOrCreateDepartment(config.larkDepartmentName);
  console.log();

  // 5. Resolve emails → Lark open_ids
  console.log('3. Resolving GitHub emails → Lark user IDs...');
  const allEmails = [...loginToEmail.values()];
  const emailToOpenId = await batchGetUserIdsByEmail(allEmails);

  const loginToOpenId = new Map<string, string>();
  for (const [login, email] of loginToEmail) {
    const openId = emailToOpenId.get(email);
    if (openId) {
      loginToOpenId.set(login, openId);
    }
  }

  const noLarkAccount = [...loginToEmail.entries()].filter(
    ([, email]) => !emailToOpenId.has(email),
  );
  if (noLarkAccount.length > 0) {
    console.log(`   ⚠ ${noLarkAccount.length} member(s) have no matching Lark account:`);
    for (const [login, email] of noLarkAccount) {
      console.log(`     - ${login} (${email})`);
    }
    console.log();
  }
  console.log(`   Resolved ${loginToOpenId.size}/${ghMembers.length} members\n`);

  // 6. Compare with current Lark department membership
  console.log('4. Comparing with current Lark department membership...');
  const currentMembers = new Set(await listDepartmentMembers(deptId));
  const desiredMembers = new Set(loginToOpenId.values());

  const toAdd = [...desiredMembers].filter((id) => !currentMembers.has(id));
  const toRemove = [...currentMembers].filter((id) => !desiredMembers.has(id));

  console.log(`   Current: ${currentMembers.size}, Desired: ${desiredMembers.size}`);
  console.log(`   To add: ${toAdd.length}, To remove: ${toRemove.length}\n`);

  // 7. Apply changes
  const result: MemberSyncResult = {
    added: [],
    removed: [],
    skipped: unmapped.map((m) => m.login),
    errors: [],
  };

  if (config.dryRun) {
    console.log('5. DRY RUN — no changes applied');
  } else {
    console.log('5. Applying changes...');

    // Note: Lark's Contact API manages department membership through the user object.
    // Adding a user to a department requires updating their department_ids via user.update().
    // This requires the contact:contact scope.
    // For users already in the org, we update their department list.

    const c = (await import('./lark.js')).getLarkClient();

    for (const openId of toAdd) {
      try {
        // Get current user info to preserve existing departments and required fields
        const userRes = await c.contact.user.get({
          path: { user_id: openId },
          params: { user_id_type: 'open_id', department_id_type: 'open_department_id' },
        });
        const user = userRes?.data?.user;
        const currentDepts = user?.department_ids ?? [];

        if (!currentDepts.includes(deptId)) {
          await c.contact.user.update({
            path: { user_id: openId },
            data: {
              name: user?.name ?? '',
              mobile: user?.mobile ?? '',
              employee_type: user?.employee_type ?? 1,
              department_ids: [...currentDepts, deptId],
            },
            params: { user_id_type: 'open_id', department_id_type: 'open_department_id' },
          });
        }
        const login = [...loginToOpenId.entries()].find(([, id]) => id === openId)?.[0] ?? openId;
        result.added.push(login);
        console.log(`   + Added ${login}`);
      } catch (err) {
        const login = [...loginToOpenId.entries()].find(([, id]) => id === openId)?.[0] ?? openId;
        result.errors.push(`Failed to add ${login}: ${err}`);
        console.error(`   ✗ Failed to add ${login}: ${err}`);
      }
    }

    if (config.syncRemoveMembers) {
      for (const openId of toRemove) {
        try {
          const userRes = await c.contact.user.get({
            path: { user_id: openId },
            params: { user_id_type: 'open_id', department_id_type: 'open_department_id' },
          });
          const user = userRes?.data?.user;
          const currentDepts = user?.department_ids ?? [];
          const newDepts = currentDepts.filter((d: string) => d !== deptId);

          // Don't remove from department if it's their only department
          if (newDepts.length > 0) {
            await c.contact.user.update({
              path: { user_id: openId },
              data: {
                name: user?.name ?? '',
                mobile: user?.mobile ?? '',
                employee_type: user?.employee_type ?? 1,
                department_ids: newDepts,
              },
              params: { user_id_type: 'open_id', department_id_type: 'open_department_id' },
            });
            result.removed.push(openId);
            console.log(`   - Removed ${openId}`);
          } else {
            console.log(`   ~ Skipped removing ${openId} (only department)`);
          }
        } catch (err) {
          result.errors.push(`Failed to remove ${openId}: ${err}`);
          console.error(`   ✗ Failed to remove ${openId}: ${err}`);
        }
      }
    }
  }

  // Summary
  console.log('\n=== Summary ===');
  console.log(`Added:   ${result.added.length}`);
  console.log(`Removed: ${result.removed.length}`);
  console.log(`Skipped: ${result.skipped.length} (no email)`);
  console.log(`Errors:  ${result.errors.length}`);

  if (result.errors.length > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
