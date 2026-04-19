/**
 * Lark interactive card templates for GitHub events.
 *
 * Each builder returns a Lark card JSON object that can be sent via the IM API.
 * Ref: https://open.larksuite.com/document/common-capabilities/message-card/message-cards-content
 */

import type { UserMapping } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type HeaderColor =
  | 'blue'
  | 'green'
  | 'orange'
  | 'red'
  | 'purple'
  | 'turquoise'
  | 'yellow'
  | 'grey';

function card(title: string, color: HeaderColor, elements: object[]) {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: title },
      template: color,
    },
    elements,
  };
}

function md(content: string) {
  return { tag: 'div', text: { tag: 'lark_md', content } };
}

function button(label: string, url: string) {
  return {
    tag: 'action',
    actions: [
      {
        tag: 'button',
        text: { tag: 'plain_text', content: label },
        url,
        type: 'primary',
      },
    ],
  };
}

function divider() {
  return { tag: 'hr' };
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/**
 * Render an @-mention if we have a matched Lark open_id, else fall back to the
 * plain login/name. Safe to call with an empty mapping — returns the fallback.
 */
export function at(
  login: string,
  mapping?: Pick<UserMapping, 'entries'>,
): string {
  if (!mapping) return login;
  const entry = mapping.entries[login];
  if (entry?.status === 'matched' && entry.lark_open_id) {
    const display = entry.lark_name || login;
    return `<at user_id="${entry.lark_open_id}">${display}</at>`;
  }
  return login;
}

// ---------------------------------------------------------------------------
// Push event
// ---------------------------------------------------------------------------

export function pushCard(payload: any) {
  const repo = payload.repository?.full_name ?? 'unknown';
  const branch = (payload.ref ?? '').replace('refs/heads/', '');
  const pusher = payload.pusher?.name ?? payload.sender?.login ?? 'unknown';
  const commits: any[] = payload.commits ?? [];
  const compareUrl: string = payload.compare ?? '';

  const commitLines = commits
    .slice(0, 5)
    .map((c: any) => {
      const sha = (c.id ?? '').slice(0, 7);
      const msg = truncate(c.message?.split('\n')[0] ?? '', 80);
      return `\`${sha}\` ${msg} — ${c.author?.name ?? 'unknown'}`;
    })
    .join('\n');

  const extra = commits.length > 5 ? `\n_… and ${commits.length - 5} more_` : '';

  return card(`📦 Push to ${branch}`, 'blue', [
    md(
      [
        `**Repository:** [${repo}](https://github.com/${repo})`,
        `**Branch:** \`${branch}\``,
        `**Pushed by:** ${pusher}`,
        `**Commits:** ${commits.length}`,
      ].join('\n'),
    ),
    divider(),
    md(commitLines + extra || '_No commits_'),
    ...(compareUrl ? [button('View Changes', compareUrl)] : []),
  ]);
}

// ---------------------------------------------------------------------------
// Issues event
// ---------------------------------------------------------------------------

export function issueCard(payload: any) {
  const action: string = payload.action ?? 'unknown';
  const issue = payload.issue ?? {};
  const repo = payload.repository?.full_name ?? 'unknown';
  const sender = payload.sender?.login ?? 'unknown';

  const colorMap: Record<string, HeaderColor> = {
    opened: 'orange',
    closed: 'green',
    reopened: 'orange',
    edited: 'blue',
    assigned: 'purple',
    labeled: 'grey',
  };

  const labels = (issue.labels ?? []).map((l: any) => `\`${l.name}\``).join(' ');

  return card(`📋 Issue ${action}: #${issue.number}`, colorMap[action] ?? 'grey', [
    md(
      [
        `**${truncate(issue.title ?? '', 100)}**`,
        '',
        `**Repository:** [${repo}](https://github.com/${repo})`,
        `**Author:** ${issue.user?.login ?? 'unknown'}`,
        `**Action by:** ${sender}`,
        `**State:** ${issue.state ?? action}`,
        labels ? `**Labels:** ${labels}` : null,
        issue.assignee ? `**Assignee:** ${issue.assignee.login}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
    ),
    ...(issue.body
      ? [divider(), md(truncate(issue.body, 500))]
      : []),
    button('View Issue', issue.html_url ?? `https://github.com/${repo}/issues`),
  ]);
}

// ---------------------------------------------------------------------------
// Issue comment event
// ---------------------------------------------------------------------------

export function issueCommentCard(payload: any) {
  const issue = payload.issue ?? {};
  const comment = payload.comment ?? {};
  const repo = payload.repository?.full_name ?? 'unknown';

  const isOnPR = !!issue.pull_request;
  const prefix = isOnPR ? '🔀 PR' : '📋 Issue';

  return card(`💬 Comment on ${prefix} #${issue.number}`, 'blue', [
    md(
      [
        `**${truncate(issue.title ?? '', 100)}**`,
        '',
        `**Repository:** [${repo}](https://github.com/${repo})`,
        `**Commenter:** ${comment.user?.login ?? 'unknown'}`,
      ].join('\n'),
    ),
    divider(),
    md(truncate(comment.body ?? '', 500)),
    button('View Comment', comment.html_url ?? issue.html_url ?? ''),
  ]);
}

// ---------------------------------------------------------------------------
// Pull request event
// ---------------------------------------------------------------------------

export function pullRequestCard(payload: any, mapping?: UserMapping) {
  const action: string = payload.action ?? 'unknown';
  const pr = payload.pull_request ?? {};
  const repo = payload.repository?.full_name ?? 'unknown';
  const sender = payload.sender?.login ?? 'unknown';
  const merged = pr.merged === true;

  let displayAction = action;
  let color: HeaderColor = 'grey';

  if (merged) {
    displayAction = 'merged';
    color = 'green';
  } else {
    const colorMap: Record<string, HeaderColor> = {
      opened: 'purple',
      closed: 'red',
      reopened: 'purple',
      edited: 'blue',
      ready_for_review: 'orange',
      review_requested: 'orange',
      synchronize: 'blue',
    };
    color = colorMap[action] ?? 'grey';
  }

  const stats = [
    pr.changed_files != null ? `**Files changed:** ${pr.changed_files}` : null,
    pr.additions != null ? `**Additions:** +${pr.additions}` : null,
    pr.deletions != null ? `**Deletions:** -${pr.deletions}` : null,
  ]
    .filter(Boolean)
    .join('  |  ');

  // On review_requested, ping the reviewer(s) if we have their Lark open_id.
  // Otherwise list them by login.
  const reviewerLogins: string[] = (pr.requested_reviewers ?? []).map(
    (r: any) => r.login,
  );
  const reviewersLine = reviewerLogins.length
    ? (action === 'review_requested' && mapping
        ? `**Reviewers:** ${reviewerLogins.map((l) => at(l, mapping)).join(' ')}`
        : `**Reviewers:** ${reviewerLogins.join(', ')}`)
    : null;

  return card(`🔀 PR ${displayAction}: #${pr.number}`, color, [
    md(
      [
        `**${truncate(pr.title ?? '', 100)}**`,
        '',
        `**Repository:** [${repo}](https://github.com/${repo})`,
        `**Author:** ${pr.user?.login ?? 'unknown'}`,
        `**Action by:** ${sender}`,
        `**Branch:** \`${pr.head?.ref ?? '?'}\` → \`${pr.base?.ref ?? '?'}\``,
        stats || null,
        reviewersLine,
      ]
        .filter(Boolean)
        .join('\n'),
    ),
    ...(pr.body ? [divider(), md(truncate(pr.body, 500))] : []),
    button('View Pull Request', pr.html_url ?? `https://github.com/${repo}/pulls`),
  ]);
}

// ---------------------------------------------------------------------------
// Pull request review event
// ---------------------------------------------------------------------------

export function pullRequestReviewCard(payload: any, mapping?: UserMapping) {
  const review = payload.review ?? {};
  const pr = payload.pull_request ?? {};
  const repo = payload.repository?.full_name ?? 'unknown';

  const stateMap: Record<string, { label: string; color: HeaderColor }> = {
    approved: { label: 'approved ✅', color: 'green' },
    changes_requested: { label: 'requested changes 🔄', color: 'orange' },
    commented: { label: 'commented 💬', color: 'blue' },
  };

  const info = stateMap[review.state] ?? { label: review.state, color: 'grey' as HeaderColor };

  // @-ping the PR author so they know they got a review
  const authorLogin = pr.user?.login ?? 'unknown';
  const authorLine = mapping
    ? `**Author:** ${at(authorLogin, mapping)}`
    : `**Author:** ${authorLogin}`;

  return card(`👀 Review ${info.label}: PR #${pr.number}`, info.color, [
    md(
      [
        `**${truncate(pr.title ?? '', 100)}**`,
        '',
        `**Repository:** [${repo}](https://github.com/${repo})`,
        `**Reviewer:** ${review.user?.login ?? 'unknown'}`,
        authorLine,
      ].join('\n'),
    ),
    ...(review.body ? [divider(), md(truncate(review.body, 500))] : []),
    button('View Review', review.html_url ?? pr.html_url ?? ''),
  ]);
}

// ---------------------------------------------------------------------------
// Release event
// ---------------------------------------------------------------------------

export function releaseCard(payload: any) {
  const release = payload.release ?? {};
  const repo = payload.repository?.full_name ?? 'unknown';

  return card(`🚀 Release: ${release.tag_name ?? 'unknown'}`, 'turquoise', [
    md(
      [
        `**${release.name ?? release.tag_name ?? 'Unnamed release'}**`,
        '',
        `**Repository:** [${repo}](https://github.com/${repo})`,
        `**Author:** ${release.author?.login ?? 'unknown'}`,
        `**Pre-release:** ${release.prerelease ? 'Yes' : 'No'}`,
      ].join('\n'),
    ),
    ...(release.body ? [divider(), md(truncate(release.body, 800))] : []),
    button('View Release', release.html_url ?? `https://github.com/${repo}/releases`),
  ]);
}

// ---------------------------------------------------------------------------
// Branch/tag create event
// ---------------------------------------------------------------------------

export function createRefCard(payload: any) {
  const refType: string = payload.ref_type ?? 'unknown'; // "branch" or "tag"
  const ref: string = payload.ref ?? 'unknown';
  const repo = payload.repository?.full_name ?? 'unknown';
  const sender = payload.sender?.login ?? 'unknown';

  return card(`🌿 ${refType} created: ${ref}`, 'green', [
    md(
      [
        `**Repository:** [${repo}](https://github.com/${repo})`,
        `**Type:** ${refType}`,
        `**Name:** \`${ref}\``,
        `**Created by:** ${sender}`,
      ].join('\n'),
    ),
    button(
      'View on GitHub',
      `https://github.com/${repo}/tree/${ref}`,
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Branch/tag delete event
// ---------------------------------------------------------------------------

export function deleteRefCard(payload: any) {
  const refType: string = payload.ref_type ?? 'unknown';
  const ref: string = payload.ref ?? 'unknown';
  const repo = payload.repository?.full_name ?? 'unknown';
  const sender = payload.sender?.login ?? 'unknown';

  return card(`🗑️ ${refType} deleted: ${ref}`, 'red', [
    md(
      [
        `**Repository:** [${repo}](https://github.com/${repo})`,
        `**Type:** ${refType}`,
        `**Name:** \`${ref}\``,
        `**Deleted by:** ${sender}`,
      ].join('\n'),
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Fork event
// ---------------------------------------------------------------------------

export function forkCard(payload: any) {
  const forkee = payload.forkee ?? {};
  const repo = payload.repository?.full_name ?? 'unknown';

  return card(`🍴 Repository forked`, 'grey', [
    md(
      [
        `**Repository:** [${repo}](https://github.com/${repo})`,
        `**Forked to:** [${forkee.full_name}](${forkee.html_url})`,
        `**By:** ${forkee.owner?.login ?? 'unknown'}`,
      ].join('\n'),
    ),
    button('View Fork', forkee.html_url ?? ''),
  ]);
}

// ---------------------------------------------------------------------------
// Star event
// ---------------------------------------------------------------------------

export function starCard(payload: any) {
  const action: string = payload.action ?? 'created';
  const repo = payload.repository ?? {};
  const sender = payload.sender?.login ?? 'unknown';

  return card(
    action === 'created' ? `⭐ New star` : `💫 Star removed`,
    action === 'created' ? 'yellow' : 'grey',
    [
      md(
        [
          `**Repository:** [${repo.full_name}](${repo.html_url})`,
          `**By:** ${sender}`,
          `**Total stars:** ${repo.stargazers_count ?? '?'}`,
        ].join('\n'),
      ),
    ],
  );
}

// ---------------------------------------------------------------------------
// Workflow run event
// ---------------------------------------------------------------------------

export function workflowRunCard(payload: any) {
  const run = payload.workflow_run ?? {};
  const repo = payload.repository?.full_name ?? 'unknown';

  const conclusionMap: Record<string, { label: string; color: HeaderColor }> = {
    success: { label: '✅ Success', color: 'green' },
    failure: { label: '❌ Failure', color: 'red' },
    cancelled: { label: '⚪ Cancelled', color: 'grey' },
    timed_out: { label: '⏰ Timed out', color: 'orange' },
  };

  const info = conclusionMap[run.conclusion] ?? {
    label: run.conclusion ?? run.status ?? 'unknown',
    color: 'grey' as HeaderColor,
  };

  return card(`⚙️ Workflow: ${info.label}`, info.color, [
    md(
      [
        `**Workflow:** ${run.name ?? 'unknown'}`,
        `**Repository:** [${repo}](https://github.com/${repo})`,
        `**Branch:** \`${run.head_branch ?? '?'}\``,
        `**Triggered by:** ${run.actor?.login ?? 'unknown'}`,
        `**Duration:** ${run.run_started_at && run.updated_at ? formatDuration(run.run_started_at, run.updated_at) : '?'}`,
      ].join('\n'),
    ),
    button('View Run', run.html_url ?? `https://github.com/${repo}/actions`),
  ]);
}

function formatDuration(start: string, end: string): string {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  if (mins < 60) return `${mins}m ${remSecs}s`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hours}h ${remMins}m`;
}

// ---------------------------------------------------------------------------
// Fallback for unsupported events
// ---------------------------------------------------------------------------

export function genericEventCard(eventName: string, payload: any) {
  const repo = payload.repository?.full_name ?? 'unknown';
  const sender = payload.sender?.login ?? 'unknown';
  const action: string = payload.action ?? '';

  return card(
    `📢 ${eventName}${action ? `: ${action}` : ''}`,
    'grey',
    [
      md(
        [
          `**Repository:** [${repo}](https://github.com/${repo})`,
          `**Triggered by:** ${sender}`,
          action ? `**Action:** ${action}` : null,
        ]
          .filter(Boolean)
          .join('\n'),
      ),
      button('View on GitHub', `https://github.com/${repo}`),
    ],
  );
}

// ---------------------------------------------------------------------------
// Admin: approval prompt for unresolved member matches
// ---------------------------------------------------------------------------

/**
 * Card posted to the admin chat when there are unresolved GitHub members
 * that couldn't be auto-matched to a Lark user.
 *
 * The button leads to the GitHub-Pages approve page which fetches the current
 * pending list from `data/user-mapping.json` and dispatches decisions.
 */
export function approvalPromptCard(opts: {
  count: number;
  org: string;
  approveUrl: string;
  sampleLogins: string[];
}) {
  const { count, org, approveUrl, sampleLogins } = opts;
  const preview = sampleLogins.slice(0, 5).map((l) => `\`${l}\``).join(', ');
  const more = sampleLogins.length > 5 ? ` and ${sampleLogins.length - 5} more` : '';

  return card(
    `⚠️ ${count} member${count === 1 ? '' : 's'} awaiting review`,
    'orange',
    [
      md(
        [
          `The GitHub↔Lark sync for \`${org}\` couldn't confidently match these users by email or name:`,
          '',
          preview + more,
          '',
          `Open the approval page, sign in with GitHub, and resolve each one with a single click. Decisions are persistent — skipped users are never re-asked.`,
        ].join('\n'),
      ),
      button('Resolve in browser →', approveUrl),
    ],
  );
}

// ---------------------------------------------------------------------------
// Repo lifecycle: archived / deleted / renamed notifications for the chat
// ---------------------------------------------------------------------------

export function repoArchivedCard(fullName: string, htmlUrl: string) {
  return card('📦 Repository archived', 'grey', [
    md(
      [
        `**Repository:** [${fullName}](${htmlUrl})`,
        '',
        'This repository has been archived on GitHub. No further events will be delivered unless it is unarchived.',
      ].join('\n'),
    ),
  ]);
}

export function repoDeletedCard(fullName: string) {
  return card('🗑️ Repository deleted', 'red', [
    md(
      [
        `**Repository:** \`${fullName}\``,
        '',
        'This repository was deleted on GitHub. This chat will no longer receive notifications.',
      ].join('\n'),
    ),
  ]);
}

export function repoRenamedCard(oldName: string, newName: string, htmlUrl: string) {
  return card('✏️ Repository renamed', 'blue', [
    md(
      [
        `**From:** \`${oldName}\``,
        `**To:** [${newName}](${htmlUrl})`,
        '',
        'This chat will continue to receive notifications for the repository under its new name.',
      ].join('\n'),
    ),
  ]);
}
