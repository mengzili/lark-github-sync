<h1 align="center">Lark ↔ GitHub Organization Sync</h1>

<p align="center">
  Keep your <b>Lark / Feishu</b> workspace and your <b>GitHub organization</b> in sync —<br/>
  members, repos, and rich event notifications, all without running a server.
</p>

<p align="center">
  <a href="https://github.com/mengzili/lark-github-sync/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/mengzili/lark-github-sync?style=flat-square"></a>
  <a href="https://github.com/mengzili/lark-github-sync/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/github/license/mengzili/lark-github-sync?style=flat-square"></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.8-3178c6?style=flat-square&logo=typescript&logoColor=white">
  <img alt="GitHub Actions" src="https://img.shields.io/badge/GitHub_Actions-ready-2088ff?style=flat-square&logo=github-actions&logoColor=white">
  <img alt="Cloudflare Workers" src="https://img.shields.io/badge/Cloudflare_Workers-deployed-f38020?style=flat-square&logo=cloudflare&logoColor=white">
</p>

<p align="center">
  <b><a href="https://zilimeng.com/lark-github-sync/">🚀 Open the setup page →</a></b>
</p>

---

## Why

If your team uses Lark/Feishu for chat and GitHub for code, you're stuck duplicating work across both. New hire joins Lark → someone has to invite them to GitHub. New repo created → someone should set up a chat. PR opened → reviewers get pinged in GitHub but not in Lark.

This repo is a **zero-ops bridge**:

- **One setup page**, ~5 minutes, done.
- **Daily cron** for member sync; **org webhooks** for everything real-time.
- **Fuzzy identity matching** that actually works for Chinese names (pinyin-aware, tolerant of surname-first vs. surname-last).
- **Invite-only** — never removes anyone. A missed match costs nothing; a false positive kicks a real contributor.

## What it does

| | |
|---|---|
| 👥 **Member sync** | Lark department → GitHub org. New hires auto-invited by email. |
| 🔤 **Fuzzy name matching** | Pinyin-aware. `Zili Meng` ↔ `孟子立` matches at 100%. Auto-links high-confidence, asks for one-click approval on ambiguous. |
| 💬 **Repo group chats** | Every repo gets its own Lark chat. Admin + matched contributors added automatically. |
| 🔔 **Rich notifications** | Push / PR / issue / review / release / CI → interactive cards in the repo's chat. |
| ⚡ **Real-time** | New repos, renames, archives, deletions, and member joins land in Lark within ~30 seconds. |
| 📣 **@-mentions** | PR reviewers get a real Lark ping (`<at user_id="ou_…">`). |
| 🛡 **Never removes** | Only invites and adds. Admins remove manually if needed. |

---

## Quick start

You need to be a **GitHub org admin** and a **Lark workspace admin** who can create a custom Lark app.

<table>
<tr>
<td width="60"><b>1</b></td>
<td>

**Create a Lark app** (~3 min) in the [Feishu console](https://open.feishu.cn/app) or [Lark console](https://open.larksuite.com/app). Activate these scopes and submit a version for approval:

```
contact:user.base:readonly      contact:user.id:readonly
contact:department.base:readonly contact:contact.base:readonly
im:chat                          im:message:send_as_bot
```

</td>
</tr>
<tr>
<td><b>2</b></td>
<td>

**Open the setup page** → <https://zilimeng.com/lark-github-sync/>

Login with GitHub, pick your org, paste your Lark App ID + Secret, confirm your Lark email, click **Deploy**.

</td>
</tr>
<tr>
<td><b>3</b></td>
<td>

**That's it.** The page creates `your-org/lark-github-sync` from the template, sets all org secrets/variables, registers the GitHub webhook, creates your Admin chat in Lark, and runs the first sync.

</td>
</tr>
</table>

---

## How it works

```
 ┌──────────────────────┐                ┌──────────────────────┐
 │  Lark / Feishu       │                │  GitHub Organization │
 │                      │                │                      │
 │  Department  ────────┼── sync ────────┼─▶  Org members        │
 │    • new hire ───────┼── auto invite ─┼─▶  direct_member      │
 │                      │                │                      │
 │  Repo group chat ◀───┼── real-time ───┼──  New repo (webhook) │
 │  Card messages ◀─────┼── notify ──────┼──  Push / PR / review │
 │  Admin chat ◀────────┼── approve ─────┼──  Fuzzy-match prompt │
 └──────────────────────┘                └──────────────────────┘
                              ▲
                              │  Cloudflare Worker
                              │  (OAuth proxy · webhook forwarder · tenant KV)
                              ▼
                            KV: { gh:<org> → { syncRepo, secret, PAT, … } }
```

**Daily (cron, 02:00 UTC)** — `sync-members` → `sync-repos` → everyone ends up in the right chats.
**Real-time (org webhook)** — new repo, rename, archive, delete, member-joined → `repository_dispatch` → handler workflow → done in <30s.
**Per event** — each repo's `lark-notify.yml` checks out this repo and runs `notify.ts` to send the card.

### Identity matching

Resolved in this order:

1. **Exact email** — Lark profile/enterprise email vs. GitHub profile email.
2. **Commit-author probe** — for GitHub users with empty profile email, scan their recent commits and strip `@users.noreply.github.com`.
3. **Fuzzy name** — token-set + Levenshtein + pinyin. Auto-links ≥ 0.95 confidence when the top candidate is unambiguous.
4. **Admin approval** — 0.70–0.95 candidates land on a web page. Sign in, click **Match** or **Skip**, decision commits to `data/user-mapping.json` and is never re-asked.

### Event cards

| Event | Header | Highlights |
|---|---|---|
| Push | 🔵 | Commit list, pusher, compare link |
| Issues | 🟠 / 🟢 | Title, labels, assignee |
| PR opened / merged / closed | 🟣 / 🟢 / 🔴 | Files, +/-, reviewers |
| PR review requested | 🟠 | **@-mentions reviewer(s)** |
| PR review submitted | 🟢 / 🟠 | **@-mentions PR author** |
| Releases | 🔷 | Tag, notes |
| CI / workflow_run | 🟢 / 🔴 | Pass/fail, duration |
| Branch/tag create/delete | 🟢 / 🔴 | Who, what |

---

## Self-hosting the Worker

The public setup page uses a shared Worker. If you'd rather own your tenant secrets:

```bash
cd worker
npm install
wrangler login

# KV for tenant records
npx wrangler kv namespace create TENANTS
# paste the id into wrangler.toml → [[kv_namespaces]].id

# Fill wrangler.toml:
#   GITHUB_CLIENT_ID → your OAuth app client id
#   ALLOWED_ORIGIN   → your GitHub Pages origin

# Set the OAuth secret in the Cloudflare dashboard
# (Workers → your worker → Settings → Variables and Secrets → add GITHUB_CLIENT_SECRET)

npx wrangler deploy
```

Then create a [GitHub OAuth App](https://github.com/settings/developers) whose callback URL is `https://your-worker.workers.dev/callback/github`, and update `WORKER_URL` in `docs/index.html` + `docs/approve.html` to your worker URL.

---

## FAQ

<details>
<summary><b>A new hire joined Lark — when do they get GitHub access?</b></summary>

On the next daily sync (02:00 UTC) or when you manually trigger `Sync GitHub ↔ Lark`. Their Lark email must be resolvable; you can also trigger a one-off bootstrap by re-running `🚀 Initial Setup`.

</details>

<details>
<summary><b>Someone left — how do I remove them?</b></summary>

Manually, in GitHub Org Settings → People. **This tool will never remove anyone.** Auto-remove is a known footgun: a bad match silently kicks a real contributor.

</details>

<details>
<summary><b>Will the approval page work for Chinese names?</b></summary>

Yes. The page decodes `user-mapping.json` as UTF-8 (via `TextDecoder`), and the fuzzy matcher runs both sides through `pinyin-pro`. `Zili Meng` ↔ `孟子立` scores 100%.

</details>

<details>
<summary><b>Can I sync more than one Lark department?</b></summary>

Not yet — `LARK_SOURCE_DEPARTMENT_ID` is a single value. Use `0` (root) and scope access inside GitHub. PRs welcome.

</details>

<details>
<summary><b>A new repo isn't getting a Lark chat.</b></summary>

Org Settings → Webhooks → Recent Deliveries. The Worker's response is in each delivery.
- `401 Bad signature` → webhook secret rotated; re-run Initial Setup.
- `404 Unknown tenant` → tenant KV record missing; re-run Initial Setup.

</details>

<details>
<summary><b>Initial Setup failed on one step.</b></summary>

Common ones:
- **Lark `99991672`** → missing a scope. The error message lists the alternatives; activate any, re-publish the version.
- **GitHub `404 /orgs/:org/hooks`** → OAuth token missing `admin:org_hook`. Revoke the app at <https://github.com/settings/applications>, log in again on the setup page.
- **`fetch failed` from setup-bootstrap** → `worker_base_url` input is wrong; override it when re-running.
- **Deploy Notifications: `Repository rule violations found`** → one repo has branch protection. The other repos are fine; open a PR on the holdout if you want it.

</details>

<details>
<summary><b>Updates?</b></summary>

Weekly `Sync from upstream` workflow PRs new commits from this repo. It's tuned for template-generated forks: prefers upstream on conflicts but preserves your `data/*.json`.

</details>

---

## Configuration reference

Set at the **org** level (done by the setup page, or manually under `Settings → Secrets and variables → Actions`).

<details>
<summary><b>Secrets</b></summary>

| Name | What it is |
|---|---|
| `LARK_APP_ID` | Lark custom app ID |
| `LARK_APP_SECRET` | Lark custom app secret |
| `SYNC_GITHUB_TOKEN` | GitHub OAuth token with `repo`, `workflow`, `admin:org`, `admin:org_hook` |

</details>

<details>
<summary><b>Variables</b></summary>

| Name | Default | What it is |
|---|---|---|
| `SYNC_GITHUB_ORG` | *(set by deploy)* | GitHub org name |
| `LARK_DOMAIN` | `feishu` | `feishu` or `lark` |
| `LARK_SOURCE_DEPARTMENT_ID` | `0` | Lark dept to sync (`0` = root) |
| `LARK_ADMIN_CHAT_ID` | *(set by deploy)* | Chat that receives approval prompts |
| `LARK_ADMIN_OPEN_ID` | *(set by deploy)* | Admin's Lark open_id (auto-added to every repo chat) |
| `APPROVE_URL_BASE` | `https://zilimeng.com/lark-github-sync` | Base URL of the approval page |

</details>

---

## Architecture

```
src/
├── sync-members.ts         — Lark dept → GitHub org (invite-only; fuzzy match + approval)
├── sync-repos.ts           — Create/maintain Lark chat for each org repo
├── setup-repos.ts          — Push lark-notify.yml to every org repo
├── notify.ts               — Send one event card; auto-add actor + relevant users
├── handle-repo-event.ts    — Real-time: repo.created / renamed / archived / deleted
├── handle-member-event.ts  — Real-time: org.member_added → add them to contributor chats
├── apply-approval.ts       — Apply one decision from the approval page
├── setup-bootstrap.ts      — One-shot: admin chat + org webhook + tenant KV record
├── repos.ts / cards.ts / lark.ts / user-mapping.ts / name-match.ts — helpers
worker/
└── src/index.ts            — OAuth proxy + /webhook/github/:org + /api/register-tenant
docs/
├── index.html              — Setup page (OAuth + Lark creds + Deploy)
├── approve.html            — Admin approval UI for ambiguous matches
└── callback.html           — OAuth popup target
.github/workflows/
├── initial-setup.yml       — One-shot bootstrap (triggered by Deploy)
├── sync.yml                — Daily cron: members → repos
├── on-repo-event.yml       — Handles repository_dispatch: repo-changed
├── on-member-event.yml     — Handles repository_dispatch: member-joined
├── on-approval.yml         — Handles repository_dispatch: approval-applied
├── setup-repos.yml         — Manual: re-push lark-notify.yml everywhere
└── sync-upstream.yml       — Weekly PR from upstream template
data/
├── repo-chat-mapping.json  — { GitHub repo full_name → Lark chat_id }
└── user-mapping.json       — { GitHub login → { lark_open_id, status, … } }
```

---

## Contributing

Issues and PRs welcome. Good places to extend:

- Multi-department sync (one Lark tenant, several GitHub orgs)
- Outbound Lark → GitHub card actions (approve PRs from Lark)
- More event-card templates
- Better UI for the approval page (bulk-select, search, undo)

Run locally:

```bash
npm install
npm run typecheck

# Set LARK_APP_ID / LARK_APP_SECRET / GITHUB_TOKEN / GITHUB_ORG in env, then:
npm run sync-members -- # DRY_RUN=true for a safe preview
npm run sync-repos
```

## License

[MIT](LICENSE) © Zili Meng and contributors.
