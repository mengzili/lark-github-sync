# Lark / Feishu ↔ GitHub Organization Sync

Keep your GitHub organization and Lark (Feishu) workspace in sync. Members, repos, and event notifications — all managed through GitHub Actions and a tiny Cloudflare Worker. No servers to run.

| Feature | What it does |
|---|---|
| **Member sync** | Lark department → GitHub org. New Lark users are invited to GitHub automatically. (Members are never removed — see below.) |
| **Fuzzy name matching** | Lark ↔ GitHub identity links even when emails differ — pinyin-aware for CJK names. Confident matches auto-link; ambiguous ones ask for one-click approval. |
| **Repo group chats** | Every GitHub repo gets its own Lark group chat. Admin + matched contributors are auto-added. |
| **Event notifications** | Push / PR / issue / review / release / CI → rich interactive cards in the repo's Lark chat. |
| **Real-time** | New repos, renames, archives, and deletes get their Lark chat + notification workflow within seconds via a GitHub org webhook. |
| **@-mentions** | PR reviewers get a real Lark ping when a review is requested. |
| **Never removes** | We only invite and add — never remove. The cost of a false positive (kicking out a legit contributor) is too high. |

## Quick start (5 min)

> **Prerequisites**: you're a GitHub org admin, a Lark workspace admin, and you can create a custom Lark app.

### 1. Create a Lark app

Open the Lark developer console and create a custom app:

- **Feishu** (China): https://open.feishu.cn/app
- **Lark** (International): https://open.larksuite.com/app

Then in **Permissions & Scopes**, activate:

| Scope | Why |
|---|---|
| `contact:user.base:readonly` | Read user names and emails |
| `contact:user.id:readonly` | Resolve user open_id by email |
| `contact:department.base:readonly` | List departments for picker |
| `contact:contact.base:readonly` | List department members |
| `im:chat` | Create/list/update group chats |
| `im:message:send_as_bot` | Send notification cards |

In **Version Management**, create a version with availability set to **All employees** and submit for approval. Approve it in the Lark Admin Console.

Copy **App ID** and **App Secret** — you'll paste them on the setup page.

### 2. Open the setup page

> **https://zilimeng.com/lark-github-sync/**

1. **Login with GitHub** — OAuth popup, authorize the `Lark-GitHub Sync` app
2. Pick your **GitHub organization** from the dropdown
3. Paste **Lark App ID + Secret**, click **Verify credentials** (turns green)
4. Choose a **Department ID** to sync (or leave `0` for the whole company)
5. Confirm your **Lark email** (auto-filled from GitHub; this seeds the admin chat)
6. Click **Deploy**

The page will:

- Create `your-org/lark-github-sync` from the template
- Set the repo secrets and org variables
- Register a GitHub org webhook pointing at the shared Worker
- Create a `Lark-GitHub Sync Admin` chat with just you in it
- Kick off the first full sync: Lark dept → GitHub, GitHub repos → Lark chats, notification workflows pushed to every repo

Total time: ~3 minutes end-to-end.

### 3. That's it

Everything runs on GitHub Actions from now on. The daily cron (02:00 UTC) keeps member sync fresh. The org webhook handles new repos, renames, archives, and deletes in real time. Per-repo `lark-notify.yml` workflows handle events.

---

## How it works

```
┌──────────────────────┐             ┌───────────────────────┐
│   Lark / Feishu      │             │   GitHub Org          │
│                      │             │                       │
│   Department ────────┼── sync ─────┼─▶ Org members (invite)│
│   + new hire ────────┼── auto ─────┼─▶ auto-invited        │
│                      │             │                       │
│   Group Chats ◀──────┼── real-time ┼── Repos (webhook)     │
│   Card Messages ◀────┼── notify ───┼── Push / PR / …       │
│   Admin chat ◀───────┼── approve ──┼── Fuzzy-match prompts │
└──────────────────────┘             └───────────────────────┘
                    ▲
                    │ Cloudflare Worker (OAuth, webhook forwarder,
                    │ tenant registry — shared across orgs, or self-hosted)
                    ▼
                 KV store
```

**Real-time path** (new repos, renames, deletes): GitHub org webhook → Worker → `repository_dispatch` → handler workflow. Latency <30s.

**Scheduled path** (member sync): GitHub Actions cron daily at 02:00 UTC. Can be triggered manually any time.

**Event path** (push / PR / issue): each org repo has a `lark-notify.yml` workflow that checks out the sync repo and runs `notify.ts`. Events land in the repo's Lark chat.

## Member matching (when emails differ)

Identity is resolved in order:

1. **Exact email** — Lark profile/enterprise email vs GitHub profile email
2. **Commit-author email probe** — recovers GitHub users whose profile email is empty by scanning their recent commits (excluding `@users.noreply.github.com`)
3. **Fuzzy name match** — pinyin-aware, tolerant of CJK surname-first vs Western surname-last. Reversed-token forms too, so `Zili Meng` matches `孟子立` (pinyin `meng zi li`) at 100%
4. **One-click approval** — anything in 70–95% confidence goes to your admin chat. Click **Resolve in browser →**, sign in with GitHub, click **Match** or **Skip**. Decisions persist in `data/user-mapping.json` and are never re-asked.

## Repo chat membership

When a Lark group chat is created for a repo, these users are added as members (idempotently):

- **The admin** (you, or whoever onboarded the org)
- **Every GitHub contributor** to the repo (commit authors + PR authors on any branch) who has a matched Lark identity in `data/user-mapping.json`

When someone pushes / opens a PR / leaves a review, the event-notify workflow also checks if the actor is matched and adds them to the chat if missing — so new org joiners auto-join their relevant chats on their first contribution.

Unmatched contributors are silently skipped until they're resolved via the approval flow.

## Event notifications

| Event | Card |
|---|---|
| Push (commits) | Blue — commit list with compare link |
| Issues opened/closed/labeled | Orange/Green — issue details |
| Issue comments | Blue — comment snippet |
| Pull Requests | Purple/Green/Red — PR stats, reviewers |
| PR review requested | Orange — **@-mentions the reviewer in Lark** |
| PR review submitted | Green/Orange — **@-mentions the PR author** |
| Releases published | Turquoise — release notes |
| CI/CD (workflow_run) | Green/Red — pass/fail with duration |
| Branch/tag create/delete | Green/Red |

All filterable from the `.github/workflows/lark-notify.yml` in each repo — delete events you don't care about.

---

## Self-hosting the Worker

The Worker is tiny (~200 lines) and free on Cloudflare's generous tier. Self-host if:

- You don't want your tenant secrets in a third party's KV (even if that third party only sees them to forward webhooks)
- You want to pin to a specific version
- You're onboarding many orgs and want full operational control

```bash
# One-time: install wrangler and log in
npm install -g wrangler
wrangler login

# From the repo:
cd worker
npm install

# Create a KV namespace for tenant records
npx wrangler kv namespace create TENANTS
# Paste the returned id into wrangler.toml under [[kv_namespaces]].id

# Edit wrangler.toml:
#   GITHUB_CLIENT_ID → your GitHub OAuth App client ID
#   ALLOWED_ORIGIN   → https://your-pages-domain

# Upload the OAuth secret via the Cloudflare dashboard
# (Workers & Pages → your worker → Settings → Variables and Secrets →
#  add GITHUB_CLIENT_SECRET as a Secret)

# Deploy
npx wrangler deploy
```

You also need a [GitHub OAuth App](https://github.com/settings/developers) with:

- **Authorization callback URL**: `https://your-worker.workers.dev/callback/github`
- The app's **Client ID** goes in `wrangler.toml`, the **Client Secret** in the Cloudflare dashboard

Then update `WORKER_URL` in `docs/index.html` and `docs/approve.html` to your worker URL, and enable GitHub Pages on the `main` branch / `/docs` folder.

---

## FAQ

**How are users matched when emails don't line up?** Exact email → commit-author email → pinyin-aware fuzzy name match → one-click admin approval for anything ambiguous.

**New Lark hire joins the department — what happens?** Next daily sync (or manually triggered), they're invited to the GitHub org by email. Their email must be resolvable to a Lark user with a visible email address.

**Someone left the company. How do I remove them?** Manually — go to GitHub Org Settings → People and remove them. **This tool will never remove anyone automatically.** The cost of a false positive (wrongly kicking out a legitimate contributor because their email or name didn't match) is too high.

**A new GitHub repo doesn't get a Lark chat.** Check org Settings → Webhooks → Recent Deliveries. Each delivery shows the Worker's response. `401 Bad signature` = the tenant's webhook secret rotated; re-run Initial Setup. `404 Unknown tenant` = the tenant record isn't in the Worker's KV; re-run Initial Setup.

**Can I sync multiple Lark departments?** Not yet — `LARK_SOURCE_DEPARTMENT_ID` is a single value. Use `0` (root) and rely on GitHub org membership to scope access if you need finer granularity. PRs welcome.

**Approval card didn't arrive.** Check that `LARK_ADMIN_CHAT_ID` is set as an org variable, and that your bot is a member of that chat. Re-run Initial Setup to recreate if needed.

**Chinese names display as garbled characters on the approve page.** You're on an old version — pull the upstream fix (PR from the `Sync from upstream` workflow) or hard-reload the approve page.

**Can I trigger the sync manually?** Yes — GitHub Actions → `Sync GitHub ↔ Lark` → Run workflow. Also `Setup Notification Workflows` pushes `lark-notify.yml` to every repo.

**Updates?** A weekly `Sync from upstream` workflow in your fork creates a PR with new commits from this upstream repo. It's tuned for template-generated forks (no shared history) and preserves your runtime state under `data/`.

---

## Troubleshooting

**Initial Setup fails on "Admin chat, webhook, tenant registration":**

- Lark permission error (`99991672`) → you're missing a scope. The error message lists the required ones; activate any in the Lark console and re-publish the app version.
- `404 /orgs/:org/hooks` → your OAuth token is missing `admin:org_hook`. Revoke the OAuth app at https://github.com/settings/applications, log in again on the setup page, click **Deploy**.
- `fetch failed` → the Worker base URL is wrong. Override the `worker_base_url` input when re-running the workflow.

**Initial Setup fails on "Deploy notification workflows" for one repo:**

- `Repository rule violations found` / `protected branch` → that repo blocks direct pushes. The other repos still got their workflow. Open a PR manually on the holdout to enable notifications there.

**Member sync invited someone I don't want:**

- Cancel the invitation at https://github.com/orgs/YOUR-ORG/people/pending_invitations. Then click **Skip** on the approve page for that user so it stops trying.

**Lark chat was created but I can't see it:**

- The bot creates chats but doesn't auto-invite users it can't identify. Re-run `Sync GitHub ↔ Lark` with `skip_members=true`, `skip_repos=false` — the admin + all matched contributors will be added.

---

## Configuration reference

Set as org-level variables/secrets (done by setup page, or manually at `https://github.com/organizations/YOUR-ORG/settings/secrets/actions`).

### Secrets

| Name | Description |
|---|---|
| `LARK_APP_ID` | Lark custom app ID |
| `LARK_APP_SECRET` | Lark custom app secret |
| `SYNC_GITHUB_TOKEN` | GitHub OAuth token — needs `repo`, `workflow`, `admin:org`, `admin:org_hook` |

### Variables

| Name | Description | Default |
|---|---|---|
| `SYNC_GITHUB_ORG` | Org name (e.g. `acme`) | *(set by deploy)* |
| `LARK_DOMAIN` | `feishu` or `lark` | `feishu` |
| `LARK_SOURCE_DEPARTMENT_ID` | Lark dept to sync | `0` (root) |
| `LARK_ADMIN_CHAT_ID` | Chat ID that receives approval prompts | *(set by deploy)* |
| `LARK_ADMIN_OPEN_ID` | Admin's Lark open_id (auto-added to every repo chat) | *(set by deploy)* |
| `APPROVE_URL_BASE` | Base URL of the approval page | `https://zilimeng.com/lark-github-sync` |

---

## Architecture

- **`src/`** — Node.js scripts run by GitHub Actions
  - `sync-members.ts` — Lark dept ↔ GitHub org member sync (invite-only)
  - `sync-repos.ts` — create Lark chat for each org repo
  - `setup-repos.ts` — push `lark-notify.yml` to every org repo
  - `notify.ts` — send one notification card for one event (invoked per repo per event)
  - `handle-repo-event.ts` — handle `repository.created/renamed/archived/deleted`
  - `apply-approval.ts` — apply one approval decision from the approve page
  - `setup-bootstrap.ts` — one-shot: admin chat + org webhook + tenant KV record
  - `repos.ts`, `cards.ts`, `lark.ts`, `name-match.ts`, `user-mapping.ts` — helpers
- **`worker/`** — Cloudflare Worker (OAuth proxy + webhook forwarder + tenant KV registry)
- **`docs/`** — GitHub Pages site
  - `index.html` — setup page (OAuth login + Lark creds + Deploy button)
  - `approve.html` — admin approval page for ambiguous member matches
  - `callback.html` — OAuth callback redirect
- **`.github/workflows/`**
  - `initial-setup.yml` — one-shot bootstrap, triggered by the deploy page
  - `sync.yml` — daily cron for member + repo sync
  - `on-repo-event.yml` — handles real-time repo lifecycle events
  - `on-approval.yml` — applies approval decisions
  - `setup-repos.yml` — manually re-push `lark-notify.yml` to all repos
  - `sync-upstream.yml` — weekly PR from upstream template
- **`data/`** — runtime state (committed to git)
  - `repo-chat-mapping.json` — GitHub repo ↔ Lark chat ID
  - `user-mapping.json` — GitHub login ↔ Lark open_id (matched / skipped / pending)

---

## License

MIT
