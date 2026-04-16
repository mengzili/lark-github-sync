# Feishu/Lark - GitHub Organization Sync

Automatically sync your GitHub organization with Lark (Feishu). Members, repos, and event notifications — all managed through GitHub Actions.

| Feature | What it does |
|---|---|
| **Member sync** | Pick a Lark department → members auto-join your GitHub org. New hire? They get access automatically. |
| **Repo group chats** | Every GitHub repo gets its own Lark group chat. |
| **Event notifications** | Pushes, PRs, issues, releases → rich interactive cards in the repo's Lark chat. |

## Quick Start (3 steps)

### 1. Create your repo from this template

Click **[Use this template](https://github.com/mengzili/lark-github-sync/generate)** to create a private copy in your GitHub org.

Then clone it:

```bash
git clone https://github.com/YOUR_ORG/lark-github-sync.git
cd lark-github-sync
npm install
```

### 2. Create a Lark app

Go to the [Lark Developer Console](https://open.larksuite.com/app) (or [Feishu](https://open.feishu.cn/app)) and create a **Custom App**. Add these permissions and request approval:

| Permission | Purpose |
|---|---|
| `contact:user.base:readonly` | Look up users by email |
| `contact:department.base` | Read departments |
| `contact:contact` | Manage department membership |
| `im:chat` | Create group chats |
| `im:message:send_as_bot` | Send notifications |

Set **App Availability** to all employees. Copy the **App ID** and **App Secret**.

### 3. Run the setup wizard

```bash
npm run setup
```

The wizard will:
- Ask for your Lark App ID and Secret
- Auto-detect your GitHub org (via `gh` CLI)
- Let you pick which Lark department to sync
- Configure all GitHub secrets and variables automatically
- Kick off the first sync

**That's it.** Everything runs automatically from here.

## How It Works

```
┌─────────────────────┐          ┌────────────────────────┐
│  Lark / Feishu       │          │  GitHub Org             │
│                      │          │                         │
│  Department ─────────┼── sync ──┼──▶ Org Members          │
│  "Engineering"       │    ↕     │                         │
│  + new hire ─────────┼── auto ──┼──▶ auto-invited         │
│  - departure ────────┼── auto ──┼──▶ auto-removed         │
│                      │          │                         │
│  Group Chats ◀───────┼── sync ──┼─── Repos                │
│  "GitHub: org/api"   │          │    ├── api               │
│  "GitHub: org/web"   │          │    ├── web               │
│                      │          │    └── infra             │
│                      │          │                         │
│  Card Messages ◀─────┼─ notify ─┼─── Events               │
│  (push/PR/issue/…)   │          │    (commits, PRs, …)    │
└─────────────────────┘          └────────────────────────┘
```

**Sync runs daily** via GitHub Actions cron (02:00 UTC). You can also trigger it manually from the Actions tab.

## Event Notifications

GitHub events show up as rich interactive cards in the repo's Lark group chat:

| Event | Card |
|---|---|
| Push (commits) | Blue — commit list with compare link |
| Issues (open/close) | Orange/Green — issue details |
| Pull Requests (open/merge/close) | Purple/Green/Red — PR stats, reviewers |
| PR Reviews (approve/request changes) | Green/Orange — review summary |
| Releases | Turquoise — release notes |
| CI/CD (workflow runs) | Green/Red — pass/fail with duration |
| Branch/tag create/delete | Green/Red |

All cards include a clickable **View on GitHub** button.

## Configuration

All configuration is handled by the setup wizard. For reference:

| Variable | Set by wizard | Description |
|---|---|---|
| `LARK_APP_ID` | Secret | Lark app credentials |
| `LARK_APP_SECRET` | Secret | Lark app credentials |
| `SYNC_GITHUB_TOKEN` | Secret | GitHub PAT for org access |
| `GITHUB_ORG` | Variable | Your GitHub org name |
| `LARK_DOMAIN` | Variable | `feishu` or `lark` |
| `LARK_SOURCE_DEPARTMENT_ID` | Variable | Lark department to sync (`0` = all) |
| `SYNC_REMOVE_MEMBERS` | Variable | Remove GitHub members not in Lark dept (default: `true`) |

## Running Locally

```bash
# Set env vars (or use .env)
export LARK_APP_ID="cli_xxx"
export LARK_APP_SECRET="xxx"
export GITHUB_TOKEN="ghp_xxx"
export GITHUB_ORG="your-org"
export LARK_SOURCE_DEPARTMENT_ID="0"

# Dry run (preview changes, no side effects)
DRY_RUN=true npm run sync-members
DRY_RUN=true npm run sync-repos
```

## FAQ

**Q: How are Lark users matched to GitHub users?**
By email. Lark accounts have email addresses; GitHub profiles have (optional) public emails. If a user's GitHub email matches their Lark email, they're linked automatically. Users with no public GitHub email will show up as "unmatchable" in the sync log.

**Q: What if someone joins my Lark department later?**
They'll be auto-invited to the GitHub org on the next sync run (daily, or trigger manually).

**Q: What if I add a new repo?**
A Lark group chat is auto-created on the next sync. Run the "Setup Notification Workflows" action to push the notification workflow to it.

**Q: Can I use the root department (whole company)?**
Yes — set `LARK_SOURCE_DEPARTMENT_ID` to `0` (the default), or select option 0 in the wizard.

## License

MIT
