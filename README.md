# Feishu/Lark &ndash; GitHub Organization Sync

Automatically sync your GitHub organization with Lark (Feishu). Members, repos, and event notifications — all managed through GitHub Actions.

| Feature | What it does |
|---|---|
| **Member sync** | Pick a Lark department &rarr; members auto-join your GitHub org. New hires get access automatically. |
| **Repo group chats** | Every GitHub repo gets its own Lark group chat. |
| **Event notifications** | Pushes, PRs, issues, releases &rarr; rich interactive cards in the repo's Lark chat. |
| **Real-time new repos** | New repos get their chat + notification workflow within seconds via an org webhook. |
| **Fuzzy name matching** | Lark ↔ GitHub identity links even when emails don't match — pinyin-aware for CJK names. |
| **Browser-based approvals** | Ambiguous matches prompt you with a one-click approval page; decisions persist in git. |
| **@-mentions** | Reviewers on PR review requests get real Lark pings. |

---

## Setup

### [Open the setup page &rarr;](https://zilimeng.com/lark-github-sync/)

1. **Login with GitHub** &mdash; one click, OAuth popup, done
2. **Create a Lark app** &mdash; ~3 min, guided walkthrough on the page
3. **Enter your Lark email** &mdash; auto-filled from GitHub, used to seed the admin chat
4. **Click Deploy** &mdash; repo, secrets, variables, org webhook, admin chat, and initial sync are all configured automatically

No CLI, no git, no PAT creation, no manual secret setting, no per-repo configuration.

---

## How It Works

```
┌─────────────────────┐          ┌────────────────────────┐
│  Lark / Feishu       │          │  GitHub Org             │
│                      │          │                         │
│  Department ─────────┼── sync ──┼──▶ Org Members          │
│  + new hire ─────────┼── auto ──┼──▶ auto-invited         │
│  - departure ────────┼── auto ──┼──▶ auto-removed         │
│                      │          │                         │
│  Group Chats ◀───────┼─ realtime┼─── Repos (webhook)      │
│  Card Messages ◀─────┼─ notify ─┼─── Events               │
│  Admin chat ◀────────┼─ approve ┼─── fuzzy-match prompts  │
└─────────────────────┘          └────────────────────────┘
```

**Real-time:** new repos, repo renames, archives, and deletions are picked up via a GitHub org webhook routed through a shared Cloudflare Worker — the Lark chat and notification workflow appear within seconds.

**Scheduled:** member sync runs daily at 02:00 UTC. Trigger manually anytime from the Actions tab.

## Member matching

Identity is resolved in this order:

1. **Exact email** — Lark profile email or enterprise email matches GitHub profile email.
2. **Commit-author email probe** — recovers GitHub users whose profile email is empty by scanning their recent commits (excluding `@users.noreply.github.com`).
3. **Fuzzy name match** — pinyin-aware, tolerant of CJK surname-first and ASCII variants. Auto-links matches with ≥95% confidence.
4. **One-click approval** — 70–95% confidence matches go to your admin chat; click the button, sign in, approve in a web page. Decisions land in `data/user-mapping.json` and are never re-asked.

## Event Notifications

| Event | Card |
|---|---|
| Push (commits) | Blue &mdash; commit list with compare link |
| Issues | Orange/Green &mdash; issue details |
| Pull Requests | Purple/Green/Red &mdash; PR stats, reviewers |
| PR Reviews | Green/Orange &mdash; review summary, @-mention PR author |
| PR review requested | Orange &mdash; @-mention reviewer(s) in their Lark |
| Releases | Turquoise &mdash; release notes |
| CI/CD | Green/Red &mdash; pass/fail with duration |
| Branch/Tag create/delete | Green/Red |

## FAQ

**How are users matched?** Email first, then commit-author email, then fuzzy name (pinyin-aware). Ambiguous cases ask you to approve in one click.

**New Lark hire?** Auto-invited to GitHub on the next daily sync.

**New GitHub repo?** Real-time: Lark group chat is created and the notification workflow is pushed within seconds via the org webhook.

**Whole company?** Set department ID to `0` (the default).

**Updates?** The repo includes a weekly `Sync from upstream` workflow that PRs new updates.

**An approval card didn't arrive?** Check that `LARK_ADMIN_CHAT_ID` is set as an org variable. Re-run the initial-setup workflow to re-create the chat if it was deleted.

**Webhook not firing?** Go to your org's Settings → Webhooks → Recent Deliveries. Each delivery shows the HTTP response from the worker — look for `401 Bad signature` (secret rotated) or `404 Unknown tenant` (tenant KV record missing).

<details>
<summary><strong>Self-hosting the OAuth worker</strong></summary>

The setup page uses a Cloudflare Worker for GitHub OAuth, Lark credential verification, and GitHub org webhook forwarding. To host your own:

```bash
cd worker
npm install
# Create a KV namespace for tenant records
npx wrangler kv namespace create TENANTS
# Paste the returned id into wrangler.toml
# Edit wrangler.toml: set GITHUB_CLIENT_ID and ALLOWED_ORIGIN
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler deploy
```

You also need a [GitHub OAuth App](https://github.com/settings/developers) with the callback URL set to `https://your-worker.workers.dev/callback/github`.

</details>

<details>
<summary><strong>Configuration reference</strong></summary>

| Variable | Description | Default |
|---|---|---|
| `LARK_APP_ID` | Secret — Lark app ID | *(required)* |
| `LARK_APP_SECRET` | Secret — Lark app secret | *(required)* |
| `SYNC_GITHUB_TOKEN` | Secret — GitHub OAuth token | *(set by deploy)* |
| `SYNC_GITHUB_ORG` | Variable — org name | *(set by deploy)* |
| `LARK_DOMAIN` | Variable — `feishu` or `lark` | `feishu` |
| `LARK_SOURCE_DEPARTMENT_ID` | Variable — Lark dept to sync | `0` (all) |
| `LARK_ADMIN_CHAT_ID` | Variable — chat that receives approval prompts | *(set by deploy)* |
| `SYNC_REMOVE_MEMBERS` | Variable — remove departed members | `true` |
| `APPROVE_URL_BASE` | Variable — base URL of the approval page | `https://zilimeng.com/lark-github-sync` |
</details>

## License

MIT
