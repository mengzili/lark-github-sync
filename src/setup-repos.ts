/**
 * Bulk: push .github/workflows/lark-notify.yml to every org repo.
 * Also runnable as a one-shot after initial setup.
 *
 * Per-repo work is delegated to `pushNotifyWorkflow` in src/repos.ts.
 */

import { Octokit } from '@octokit/rest';
import { loadConfig } from './config.js';
import { pushNotifyWorkflow } from './repos.js';

async function main() {
  const config = loadConfig();
  const octokit = new Octokit({ auth: config.githubToken });
  const syncRepoFullName = process.env.GITHUB_REPOSITORY ?? `${config.githubOrg}/feishu-github-sync`;

  console.log(`=== Setup: Push notification workflow to ${config.githubOrg} repos ===\n`);

  const repos: Array<{ name: string; full_name: string; default_branch: string }> = [];
  for await (const response of octokit.paginate.iterator(octokit.repos.listForOrg, {
    org: config.githubOrg,
    per_page: 100,
    type: 'all',
  })) {
    for (const repo of response.data) {
      if (repo.full_name === syncRepoFullName) continue;
      repos.push({
        name: repo.name,
        full_name: repo.full_name,
        default_branch: repo.default_branch ?? 'main',
      });
    }
  }

  console.log(`Found ${repos.length} repos (excluding sync repo)\n`);

  let created = 0, updated = 0, skipped = 0, protected_ = 0, errors = 0;

  for (const repo of repos) {
    try {
      const status = await pushNotifyWorkflow(
        octokit,
        config.githubOrg,
        repo.name,
        repo.default_branch,
        syncRepoFullName,
        { dryRun: config.dryRun },
      );
      if (status === 'created') { created++; console.log(`  + ${repo.full_name} — created`); }
      else if (status === 'updated') { updated++; console.log(`  ✓ ${repo.full_name} — updated`); }
      else { skipped++; console.log(`  ~ ${repo.full_name} — already up to date`); }
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      // Branch protection / ruleset blocks direct push — skip, don't fail the job.
      // Admin can enable the workflow manually or loosen the rule.
      if (/Repository rule violations|protected branch|required status check/i.test(msg)) {
        protected_++;
        console.warn(`  ⚠ ${repo.full_name} — protected branch; skip (open a PR to enable notifications here)`);
      } else {
        console.error(`  ✗ ${repo.full_name} — failed: ${msg}`);
        errors++;
      }
    }
  }

  console.log('\n=== Summary ===');
  console.log(`Created:   ${created}`);
  console.log(`Updated:   ${updated}`);
  console.log(`Skipped:   ${skipped} (already up to date)`);
  console.log(`Protected: ${protected_} (skipped — open a PR on those repos)`);
  console.log(`Errors:    ${errors}`);

  if (errors > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
