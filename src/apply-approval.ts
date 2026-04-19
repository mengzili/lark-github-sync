/**
 * Apply one approval decision dispatched from the approve page.
 *
 * Triggered by a `repository_dispatch: approval-applied` event with payload:
 *   { github_login: string,
 *     decision: "match" | "skip" | "invite-email",
 *     lark_open_id?: string,    // required for "match"
 *     lark_name?: string,       // required for "match"
 *     email?: string,           // required for "match" (to invite) and "invite-email"
 *     decided_by?: string }     // the admin's GitHub login
 *
 * Guarantees idempotency: if the entry is no longer in `pending`, this is a no-op.
 */

import fs from 'node:fs';
import { Octokit } from '@octokit/rest';
import { formatLarkError } from './lark.js';
import {
  isPending,
  isResolved,
  loadUserMapping,
  recordMatch,
  recordSkip,
  saveUserMapping,
} from './user-mapping.js';

interface ApprovalPayload {
  github_login: string;
  decision: 'match' | 'skip' | 'invite-email';
  lark_open_id?: string;
  lark_name?: string;
  email?: string;
  decided_by?: string;
}

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Required env var ${name} is not set`);
  return v;
}

async function main() {
  const eventPath = requiredEnv('GITHUB_EVENT_PATH');
  const org = requiredEnv('GITHUB_ORG');
  const token = requiredEnv('GITHUB_TOKEN');

  const event = JSON.parse(fs.readFileSync(eventPath, 'utf-8'));
  const payload = event.client_payload as ApprovalPayload;

  if (!payload || !payload.github_login || !payload.decision) {
    throw new Error(`Malformed client_payload: ${JSON.stringify(payload)}`);
  }

  const { github_login: ghLogin, decision, lark_open_id, lark_name, email, decided_by } = payload;

  console.log(`Approval received: ${ghLogin} → ${decision} (by ${decided_by ?? 'unknown'})`);

  const mapping = loadUserMapping();

  if (!isPending(mapping, ghLogin)) {
    if (isResolved(mapping, ghLogin)) {
      console.log(`  Already resolved — no-op (idempotent).`);
      return;
    }
    console.warn(`  Not in pending list — ignoring stale approval.`);
    return;
  }

  const octokit = new Octokit({ auth: token });

  switch (decision) {
    case 'match': {
      if (!lark_open_id || !lark_name) {
        throw new Error('decision=match requires lark_open_id and lark_name');
      }
      recordMatch(mapping, ghLogin, {
        lark_open_id,
        lark_name,
        email,
        decided_by,
      });
      // Invite to GitHub org if we have an email and they're not already a member/invitee
      if (email) {
        try {
          await octokit.orgs.createInvitation({
            org,
            email,
            role: 'direct_member',
          });
          console.log(`  + Invited ${email} to ${org}`);
        } catch (err: any) {
          const msg = err?.response?.data?.errors?.[0]?.message ?? err?.message ?? String(err);
          // "already a member" / "already invited" are benign
          if (/already|pending/i.test(msg)) {
            console.log(`  (skip invite — ${msg})`);
          } else {
            throw err;
          }
        }
      }
      break;
    }

    case 'skip': {
      recordSkip(mapping, ghLogin, decided_by);
      console.log(`  Skipped — ${ghLogin} will not be re-asked.`);
      break;
    }

    case 'invite-email': {
      if (!email) throw new Error('decision=invite-email requires email');
      recordMatch(mapping, ghLogin, {
        email,
        decided_by,
      });
      try {
        await octokit.orgs.createInvitation({
          org,
          email,
          role: 'direct_member',
        });
        console.log(`  + Invited ${email} to ${org} (no Lark link)`);
      } catch (err: any) {
        const msg = err?.response?.data?.errors?.[0]?.message ?? err?.message ?? String(err);
        if (/already|pending/i.test(msg)) {
          console.log(`  (skip invite — ${msg})`);
        } else {
          throw err;
        }
      }
      break;
    }

    default:
      throw new Error(`Unknown decision: ${decision}`);
  }

  saveUserMapping(mapping);
  console.log('Mapping updated.');
}

main().catch((err) => {
  console.error('Fatal error:', formatLarkError(err));
  process.exit(1);
});
