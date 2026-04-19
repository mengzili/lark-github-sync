/**
 * Interactive setup wizard.
 *
 * Run: npm run setup
 *
 * Guides the user through the entire configuration in ~5 minutes:
 *   1. Create a Lark app (opens browser) → paste App ID + Secret
 *   2. Auto-detect GitHub org via `gh` CLI
 *   3. Pick a Lark department to sync
 *   4. Set all GitHub secrets/variables automatically
 *   5. Run initial sync + deploy notification workflows
 */

import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { execSync } from 'node:child_process';
import { platform } from 'node:os';
import * as lark from '@larksuiteoapi/node-sdk';
import {
  initLarkClientDirect,
  verifyCredentials,
  listDepartments,
  listDepartmentMembersDetailed,
} from './lark.js';
import type { LarkDepartment } from './types.js';

const rl = readline.createInterface({ input: stdin, output: stdout });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function run(cmd: string): string {
  try {
    return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return '';
  }
}

function openBrowser(url: string) {
  const cmd =
    platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'start' : 'xdg-open';
  try {
    execSync(`${cmd} "${url}"`, { stdio: 'ignore' });
  } catch {
    console.log(`  Please open this URL manually: ${url}`);
  }
}

async function ask(prompt: string): Promise<string> {
  const answer = await rl.question(prompt);
  return answer.trim();
}

async function confirm(prompt: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? '(Y/n)' : '(y/N)';
  const answer = await ask(`${prompt} ${hint} `);
  if (answer === '') return defaultYes;
  return answer.toLowerCase().startsWith('y');
}

function ghSetSecret(name: string, value: string, org?: string) {
  if (org) {
    run(`gh secret set ${name} --org "${org}" --visibility all --body "${value}"`);
  } else {
    run(`gh secret set ${name} --body "${value}"`);
  }
}

function ghSetVariable(name: string, value: string, org?: string) {
  if (org) {
    // Try update first, then create
    const updated = run(`gh variable set ${name} --org "${org}" --visibility all --body "${value}" 2>&1`);
    if (updated.includes('error') || updated.includes('Error')) {
      run(`gh variable set ${name} --org "${org}" --visibility all --body "${value}"`);
    }
  } else {
    run(`gh variable set ${name} --body "${value}"`);
  }
}

function printStep(n: number, title: string) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  Step ${n}: ${title}`);
  console.log('='.repeat(60));
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

async function stepLarkApp(): Promise<{
  appId: string;
  appSecret: string;
  domain: typeof lark.Domain.Feishu | typeof lark.Domain.Lark;
}> {
  printStep(1, 'Create a Lark / Feishu App');

  const domainChoice = await ask(
    '\n  Are you using Feishu (China) or Lark (International)?\n  1. Feishu (飞书)\n  2. Lark\n  Choose [1]: ',
  );
  const isLark = domainChoice === '2';
  const domain = isLark ? lark.Domain.Lark : lark.Domain.Feishu;
  const consoleUrl = isLark
    ? 'https://open.larksuite.com/app'
    : 'https://open.feishu.cn/app';

  console.log(`\n  Opening the developer console in your browser...`);
  console.log(`  URL: ${consoleUrl}\n`);
  openBrowser(consoleUrl);

  console.log('  Please create a new Custom App in the console.');
  console.log('  Give it a name like "GitHub Sync Bot".\n');
  console.log('  Then add these permissions (Permissions & Scopes):');
  console.log('    - contact:user.base:readonly   (Read user basic info)');
  console.log('    - contact:user.id:readonly     (Resolve user ID by email)');
  console.log('    - contact:department.base       (Read department info)');
  console.log('    - contact:contact               (Manage contacts)');
  console.log('    - im:chat                       (Manage group chats)');
  console.log('    - im:message:send_as_bot        (Send messages as bot)\n');
  console.log('  After adding permissions, submit for admin approval.');
  console.log('  Set App Availability to "All employees".\n');

  const appId = await ask('  Paste your App ID:     ');
  const appSecret = await ask('  Paste your App Secret: ');

  if (!appId || !appSecret) {
    console.error('\n  App ID and Secret are required.');
    process.exit(1);
  }

  // Verify credentials
  console.log('\n  Verifying credentials...');
  initLarkClientDirect(appId, appSecret, domain);
  const ok = await verifyCredentials();
  if (ok) {
    console.log('  Credentials verified!\n');
  } else {
    console.log('  Warning: Could not verify credentials.');
    console.log('  This usually means permissions haven\'t been approved yet.');
    console.log('  You can continue — the sync will work once permissions are approved.\n');
  }

  return { appId, appSecret, domain };
}

async function stepGitHub(): Promise<{ org: string; useOrgSecrets: boolean }> {
  printStep(2, 'GitHub Configuration');

  // Check gh CLI
  const ghVersion = run('gh --version');
  if (!ghVersion) {
    console.error('\n  The GitHub CLI (gh) is required but not installed.');
    console.error('  Install it: https://cli.github.com');
    process.exit(1);
  }

  // Check auth
  const ghUser = run('gh api user -q .login');
  if (!ghUser) {
    console.error('\n  You are not logged in to GitHub CLI.');
    console.error('  Run: gh auth login');
    process.exit(1);
  }
  console.log(`\n  Logged in to GitHub as: ${ghUser}`);

  // Detect org from current repo
  const remoteUrl = run('gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null');
  let detectedOrg = '';
  if (remoteUrl && remoteUrl.includes('/')) {
    detectedOrg = remoteUrl.split('/')[0];
  }

  let org: string;
  if (detectedOrg) {
    const useDetected = await confirm(`  Detected GitHub org: "${detectedOrg}". Use this?`);
    org = useDetected ? detectedOrg : await ask('  Enter your GitHub org name: ');
  } else {
    org = await ask('  Enter your GitHub org name: ');
  }

  if (!org) {
    console.error('\n  GitHub org name is required.');
    process.exit(1);
  }

  const useOrgSecrets = await confirm(
    '\n  Set Lark secrets at the org level (recommended, so all repos can send notifications)?',
  );

  return { org, useOrgSecrets };
}

async function stepDepartment(
  domain: typeof lark.Domain.Feishu | typeof lark.Domain.Lark,
): Promise<string> {
  printStep(3, 'Choose a Lark Department');
  console.log('\n  Which Lark department should be synced to the GitHub org?');
  console.log('  Members of this department will be invited to the GitHub org.');
  console.log('  New members added to this department will auto-join.\n');

  console.log('  Fetching departments...\n');

  let departments: LarkDepartment[];
  try {
    departments = await listDepartments('0');
  } catch (err) {
    console.log('  Could not fetch departments (permissions may not be approved yet).');
    console.log('  You can set this later via the LARK_SOURCE_DEPARTMENT_ID variable.\n');
    const manual = await ask('  Enter department ID manually (or press Enter for root/all): ');
    return manual || '0';
  }

  if (departments.length === 0) {
    console.log('  No sub-departments found. Using root (all employees).');
    return '0';
  }

  console.log('  0. All employees (root)');
  for (let i = 0; i < departments.length; i++) {
    const d = departments[i];
    const count = d.member_count != null ? ` (${d.member_count} members)` : '';
    console.log(`  ${i + 1}. ${d.name}${count}`);
  }

  const choice = await ask(`\n  Choose [0-${departments.length}]: `);
  const idx = parseInt(choice, 10);

  if (isNaN(idx) || idx < 0 || idx > departments.length) {
    console.log('  Invalid choice, using root.');
    return '0';
  }

  if (idx === 0) return '0';

  const selected = departments[idx - 1];
  console.log(`\n  Selected: "${selected.name}" (${selected.department_id})`);
  return selected.department_id;
}

async function stepConfigure(opts: {
  appId: string;
  appSecret: string;
  domain: typeof lark.Domain.Feishu | typeof lark.Domain.Lark;
  org: string;
  useOrgSecrets: boolean;
  departmentId: string;
}) {
  printStep(4, 'Configuring GitHub Secrets & Variables');

  const { appId, appSecret, org, useOrgSecrets, departmentId, domain } = opts;
  const scope = useOrgSecrets ? org : undefined;
  const scopeLabel = useOrgSecrets ? `org:${org}` : 'this repo';
  const domainStr = domain === lark.Domain.Lark ? 'lark' : 'feishu';

  console.log(`\n  Setting secrets on ${scopeLabel}...`);
  ghSetSecret('LARK_APP_ID', appId, scope);
  console.log('    LARK_APP_ID');
  ghSetSecret('LARK_APP_SECRET', appSecret, scope);
  console.log('    LARK_APP_SECRET');

  // For SYNC_GITHUB_TOKEN, use the user's current gh token
  const ghToken = run('gh auth token');
  if (ghToken) {
    ghSetSecret('SYNC_GITHUB_TOKEN', ghToken, scope);
    console.log('    SYNC_GITHUB_TOKEN (from your gh auth)');
  } else {
    console.log('    Warning: Could not get gh auth token.');
    console.log('    You\'ll need to set SYNC_GITHUB_TOKEN manually.');
  }

  console.log(`\n  Setting variables on ${scopeLabel}...`);
  ghSetVariable('SYNC_GITHUB_ORG', org, scope);
  console.log(`    SYNC_GITHUB_ORG = ${org}`);
  ghSetVariable('LARK_DOMAIN', domainStr, scope);
  console.log(`    LARK_DOMAIN = ${domainStr}`);
  ghSetVariable('LARK_SOURCE_DEPARTMENT_ID', departmentId, scope);
  console.log(`    LARK_SOURCE_DEPARTMENT_ID = ${departmentId}`);

  console.log('\n  Done!');
}

async function stepRunSync() {
  printStep(5, 'Initial Sync');

  const runNow = await confirm(
    '\n  Run the initial sync now? This will:\n' +
    '    - Invite Lark department members to the GitHub org\n' +
    '    - Create Lark group chats for each repo\n' +
    '    - Deploy notification workflows to all repos\n\n  Run now?',
  );

  if (!runNow) {
    console.log('\n  Skipped. You can run it later:');
    console.log('    GitHub Actions → "Sync GitHub ↔ Lark" → Run workflow');
    return;
  }

  console.log('\n  Triggering sync workflow...');
  const result = run('gh workflow run sync.yml 2>&1');
  if (result.includes('error') || result.includes('Error')) {
    console.log(`  Could not trigger workflow: ${result}`);
    console.log('  You can run it manually: Actions → "Sync GitHub ↔ Lark" → Run workflow');
  } else {
    console.log('  Sync workflow triggered! Check the Actions tab for progress.');
  }

  console.log('\n  Deploying notification workflows to org repos...');
  const result2 = run('gh workflow run setup-repos.yml 2>&1');
  if (result2.includes('error') || result2.includes('Error')) {
    console.log(`  Could not trigger setup: ${result2}`);
    console.log('  You can run it manually: Actions → "Setup Notification Workflows" → Run workflow');
  } else {
    console.log('  Setup workflow triggered!');
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('\n' + '='.repeat(60));
  console.log('  Feishu/Lark - GitHub Organization Sync');
  console.log('  Interactive Setup Wizard');
  console.log('='.repeat(60));
  console.log('\n  This will set up automatic syncing between your');
  console.log('  GitHub organization and Lark/Feishu in about 5 minutes.\n');

  // Step 1: Lark app
  const { appId, appSecret, domain } = await stepLarkApp();

  // Step 2: GitHub
  const { org, useOrgSecrets } = await stepGitHub();

  // Step 3: Department
  const departmentId = await stepDepartment(domain);

  // Step 4: Configure secrets/variables
  await stepConfigure({ appId, appSecret, domain, org, useOrgSecrets, departmentId });

  // Step 5: Run sync
  await stepRunSync();

  // Done!
  console.log('\n' + '='.repeat(60));
  console.log('  Setup complete!');
  console.log('='.repeat(60));
  console.log(`
  What happens now:
  - Every day at 02:00 UTC, members and repos are synced automatically.
  - New Lark department members are invited to the GitHub org.
  - New GitHub repos get a Lark group chat.
  - Pushes, PRs, issues, releases → Lark notification cards.

  Useful commands:
  - Run sync manually: Actions → "Sync GitHub ↔ Lark" → Run workflow
  - Deploy to new repos: Actions → "Setup Notification Workflows"
  - Check logs: Actions tab in this repository
`);

  rl.close();
}

main().catch((err) => {
  console.error('\nSetup failed:', err);
  rl.close();
  process.exit(1);
});
