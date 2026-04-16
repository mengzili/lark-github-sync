# Feishu/Lark &ndash; GitHub Organization Sync

Automatically sync your GitHub organization with Lark (Feishu). Members, repos, and event notifications — all managed through GitHub Actions. **Nothing to install.**

| Feature | What it does |
|---|---|
| **Member sync** | Pick a Lark department &rarr; members auto-join your GitHub org. New hires get access automatically. |
| **Repo group chats** | Every GitHub repo gets its own Lark group chat. |
| **Event notifications** | Pushes, PRs, issues, releases &rarr; rich interactive cards in the repo's Lark chat. |

---

## Setup (100% in the browser)

> **[Open the visual setup guide](https://zilimeng.com/lark-github-sync/)** for clickable links and step-by-step instructions.

### 1. Use this template &nbsp;`~10 sec`

Click **[Use this template](https://github.com/new?template_owner=mengzili&template_name=lark-github-sync&name=lark-github-sync&description=Automatically+sync+GitHub+org+with+Lark%2FFeishu+%E2%80%94+members%2C+repos%2C+and+notifications&visibility=private)** — name, description, and visibility are pre-filled. Just pick your org and click *Create*.

### 2. Create a Lark app + set 3 secrets &nbsp;`~3 min`

Open the developer console ([Feishu](https://open.feishu.cn/app) / [Lark](https://open.larksuite.com/app)), create a **Custom App**, and add these permissions:

| Permission | Purpose |
|---|---|
| `contact:user.base:readonly` | Look up users by email |
| `contact:department.base` | Read departments |
| `contact:contact:readonly_as_app` | List department members |
| `contact:contact` | Manage department membership |
| `im:chat` | Create group chats |
| `im:message:send_as_bot` | Send notifications |

Submit for approval, set availability to **All employees**, then go to your new repo's **Settings &rarr; Secrets &rarr; Actions** and add:

| Secret | Value |
|---|---|
| `LARK_APP_ID` | From the Lark app |
| `LARK_APP_SECRET` | From the Lark app |
| `SYNC_GITHUB_TOKEN` | [Create a GitHub PAT](https://github.com/settings/tokens/new?description=lark-github-sync&scopes=repo,admin:org) with `repo` + `admin:org` scopes |

### 3. Run Initial Setup &nbsp;`~1 min`

Go to **Actions &rarr; :rocket: Initial Setup &rarr; Run workflow**. Fill in your GitHub org name, choose `feishu` or `lark`, and optionally pick a department ID (`0` = all employees).

**That's it.** The workflow configures everything, syncs members, creates group chats, and deploys notifications to all your repos.

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

**Can I sync the whole company?** Yes — set `lark_department_id` to `0` (the default).

## Advanced

<details>
<summary>Run locally (optional)</summary>

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
<summary>Configuration reference</summary>

| Variable | Description | Default |
|---|---|---|
| `LARK_APP_ID` | Secret — Lark app ID | *(required)* |
| `LARK_APP_SECRET` | Secret — Lark app secret | *(required)* |
| `SYNC_GITHUB_TOKEN` | Secret — GitHub PAT | *(required)* |
| `GITHUB_ORG` | Variable — org name | *(set by setup)* |
| `LARK_DOMAIN` | Variable — `feishu` or `lark` | `feishu` |
| `LARK_SOURCE_DEPARTMENT_ID` | Variable — Lark dept to sync | `0` (all) |
| `SYNC_REMOVE_MEMBERS` | Variable — remove departed members | `true` |
</details>

## License

MIT
