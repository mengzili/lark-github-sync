# Feishu/Lark &ndash; GitHub Organization Sync

Automatically sync your GitHub organization with Lark (Feishu). Members, repos, and event notifications — all managed through GitHub Actions.

| Feature | What it does |
|---|---|
| **Member sync** | Pick a Lark department &rarr; members auto-join your GitHub org. New hires get access automatically. |
| **Repo group chats** | Every GitHub repo gets its own Lark group chat. |
| **Event notifications** | Pushes, PRs, issues, releases &rarr; rich interactive cards in the repo's Lark chat. |

---

## Setup

### [Open the setup page &rarr;](https://zilimeng.com/lark-github-sync/)

1. **Login with GitHub** &mdash; one click, OAuth popup, done
2. **Create a Lark app** &mdash; ~3 min, guided walkthrough on the page
3. **Click Deploy** &mdash; repo, secrets, variables, and initial sync are all configured automatically

No CLI, no git, no PAT creation, no manual secret setting.

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
│  Group Chats ◀───────┼── sync ──┼─── Repos                │
│  Card Messages ◀─────┼─ notify ─┼─── Events               │
└─────────────────────┘          └────────────────────────┘
```

**Sync runs daily** via GitHub Actions (02:00 UTC). Trigger manually anytime from the Actions tab.

## Event Notifications

| Event | Card |
|---|---|
| Push (commits) | Blue &mdash; commit list with compare link |
| Issues | Orange/Green &mdash; issue details |
| Pull Requests | Purple/Green/Red &mdash; PR stats, reviewers |
| PR Reviews | Green/Orange &mdash; review summary |
| Releases | Turquoise &mdash; release notes |
| CI/CD | Green/Red &mdash; pass/fail with duration |
| Branch/Tag create/delete | Green/Red |

## FAQ

**How are users matched?** By email. Lark account email ↔ GitHub public email.

**New Lark hire?** Auto-invited to GitHub on next daily sync.

**New repo?** Group chat auto-created. Run "Setup Notification Workflows" action to push the notification workflow.

**Whole company?** Set department ID to `0` (the default).

**Updates?** The repo includes a weekly `Sync from upstream` workflow that PRs new updates.

<details>
<summary><strong>Self-hosting the OAuth worker</strong></summary>

The setup page uses a Cloudflare Worker for GitHub OAuth token exchange and Lark credential verification. To host your own:

```bash
cd worker
npm install
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
| `GITHUB_ORG` | Variable — org name | *(set by deploy)* |
| `LARK_DOMAIN` | Variable — `feishu` or `lark` | `feishu` |
| `LARK_SOURCE_DEPARTMENT_ID` | Variable — Lark dept to sync | `0` (all) |
| `SYNC_REMOVE_MEMBERS` | Variable — remove departed members | `true` |
</details>

## License

MIT
