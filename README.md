# Feishu/Lark &ndash; GitHub Organization Sync

Automatically sync your GitHub organization with Lark (Feishu). Members, repos, and event notifications — all managed through GitHub Actions. **Nothing to install.**

| Feature | What it does |
|---|---|
| **Member sync** | Pick a Lark department &rarr; members auto-join your GitHub org. New hires get access automatically. |
| **Repo group chats** | Every GitHub repo gets its own Lark group chat. |
| **Event notifications** | Pushes, PRs, issues, releases &rarr; rich interactive cards in the repo's Lark chat. |

---

## Setup

### [One-Click Deploy](https://zilimeng.com/lark-github-sync/)

Open the deploy page, fill in your Lark and GitHub credentials, click **Deploy**. The page creates the repo, sets secrets, and triggers the first sync — all from your browser.

You only need two things beforehand:
1. **A Lark custom app** — the deploy page walks you through creating one (~3 min)
2. **A GitHub PAT** — the deploy page links you to the creation form with pre-filled scopes

That's it. Everything else is automated.

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

All cards include a clickable **View on GitHub** button.

## FAQ

**How are users matched?** By email. If the email on a Lark account matches a GitHub profile's public email, they're linked automatically.

**What if someone joins Lark later?** They're auto-invited to GitHub on the next daily sync (or trigger it manually).

**New repo added?** Group chat is auto-created on next sync. Run "Setup Notification Workflows" to push the notification workflow.

**Can I sync the whole company?** Yes — set department ID to `0` (the default).

**How do I get updates?** The repo includes a weekly `Sync from upstream` workflow that creates a PR when new updates are available.

<details>
<summary><strong>Advanced: run locally</strong></summary>

```bash
git clone https://github.com/YOUR_ORG/lark-github-sync.git
cd lark-github-sync && npm install

export LARK_APP_ID="cli_xxx" LARK_APP_SECRET="xxx"
export GITHUB_TOKEN="ghp_xxx" GITHUB_ORG="your-org"

DRY_RUN=true npm run sync-members   # preview
DRY_RUN=true npm run sync-repos     # preview
npm run setup                        # interactive CLI wizard
```
</details>

<details>
<summary><strong>Configuration reference</strong></summary>

| Variable | Description | Default |
|---|---|---|
| `LARK_APP_ID` | Secret — Lark app ID | *(required)* |
| `LARK_APP_SECRET` | Secret — Lark app secret | *(required)* |
| `SYNC_GITHUB_TOKEN` | Secret — GitHub PAT | *(required)* |
| `GITHUB_ORG` | Variable — org name | *(set by deploy)* |
| `LARK_DOMAIN` | Variable — `feishu` or `lark` | `feishu` |
| `LARK_SOURCE_DEPARTMENT_ID` | Variable — Lark dept to sync | `0` (all) |
| `SYNC_REMOVE_MEMBERS` | Variable — remove departed members | `true` |
</details>

## License

MIT
