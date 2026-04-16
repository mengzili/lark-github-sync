# feishu-github-sync

Automatically sync your GitHub organization with Lark (Feishu): members, repositories, and event notifications.

## What It Does

| Feature | Description |
|---|---|
| **Member Sync** | GitHub org members are synced to a dedicated Lark department. Matches users by email. |
| **Repo → Group Chat** | Each GitHub repo gets a Lark group chat. New repos are detected and chats created automatically. |
| **Event Notifications** | Pushes, issues, PRs, releases, reviews, and more appear as rich interactive cards in the repo's Lark chat. |

All automation runs via GitHub Actions — no external servers needed.

## Architecture

```
┌──────────────────────┐          ┌─────────────────────────┐
│   GitHub Org          │          │   Lark / Feishu          │
│                       │          │                          │
│  Members ─────────────┼── sync ──┼──▶ Department            │
│                       │          │    "GitHub Organization"  │
│  Repos ───────────────┼── sync ──┼──▶ Group Chats            │
│   ├── repo-a          │          │    ├── "GitHub: org/a"    │
│   ├── repo-b          │          │    ├── "GitHub: org/b"    │
│   └── repo-c          │          │    └── "GitHub: org/c"    │
│                       │          │                           │
│  Events (push/PR/…) ──┼─ notify ─┼──▶ Card Messages          │
└──────────────────────┘          └──────────────────────────┘
```

**Workflow overview:**

1. **`sync.yml`** runs daily (cron) — syncs members to a Lark department and creates group chats for new repos.
2. **`setup-repos.yml`** (manual trigger) — pushes a notification workflow file to all org repos.
3. **`lark-notify.yml`** (in each repo) — triggers on GitHub events, sends rich card notifications to the repo's Lark chat.

## Setup Guide

### Step 1: Create a Lark Custom App

1. Go to [Lark Open Platform](https://open.larksuite.com/app) (or [Feishu Open Platform](https://open.feishu.cn/app) for China)
2. Click **Create Custom App**
3. Fill in the app name (e.g., "GitHub Sync Bot") and description
4. Note your **App ID** and **App Secret**

#### Required Permissions

Go to **Permissions & Scopes** and add:

| Permission | Scope | Purpose |
|---|---|---|
| View contact information | `contact:user.base:readonly` | Look up users by email |
| Manage department information | `contact:department.base` | Create/manage the GitHub department |
| Access contact information | `contact:contact` | Update user department assignments |
| Manage group chats | `im:chat` | Create and manage group chats |
| Send messages as bot | `im:message:send_as_bot` | Send notification cards |

> After adding permissions, click **Request Approval** and have your Lark admin approve them.

#### App Availability

Go to **App Availability** → Set to all employees (or specific departments as needed).

### Step 2: Create This Repository

Create a private repository in your GitHub organization (e.g., `your-org/feishu-github-sync`) and push this code.

### Step 3: Create a GitHub Personal Access Token

The sync workflows need a GitHub token with org-level access:

1. Go to GitHub → **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens**
2. Create a new token with:
   - **Resource owner:** Your organization
   - **Repository access:** All repositories
   - **Permissions:**
     - Repository: **Contents** (read/write) — to push workflow files
     - Repository: **Variables** (read/write) — to set `LARK_CHAT_ID` on repos
     - Organization: **Members** (read) — to list org members

### Step 4: Configure GitHub Secrets & Variables

Go to your `feishu-github-sync` repo → **Settings** → **Secrets and variables** → **Actions**.

#### Secrets (repo-level or org-level)

| Secret | Value |
|---|---|
| `LARK_APP_ID` | Your Lark app's App ID |
| `LARK_APP_SECRET` | Your Lark app's App Secret |
| `SYNC_GITHUB_TOKEN` | The personal access token from Step 3 |

> **Recommended:** Set `LARK_APP_ID` and `LARK_APP_SECRET` as **organization secrets** (so all repos can access them for notifications).

#### Variables (repo-level)

| Variable | Value | Default |
|---|---|---|
| `GITHUB_ORG` | Your GitHub organization name | *(required)* |
| `LARK_DOMAIN` | `feishu` or `lark` | `feishu` |
| `LARK_DEPARTMENT_NAME` | Name for the synced department | `GitHub Organization` |
| `SYNC_REMOVE_MEMBERS` | Remove departed members from dept | `true` |

### Step 5: Map GitHub Users to Lark (Optional)

GitHub users are matched to Lark users by email. If your team members have their email public on GitHub, this works automatically. For members without public emails, add manual mappings:

Edit `data/user-mapping.json`:

```json
{
  "github-username-1": "user1@yourcompany.com",
  "github-username-2": "user2@yourcompany.com"
}
```

### Step 6: Run Initial Sync

1. Go to **Actions** → **Sync GitHub → Lark**
2. Click **Run workflow**
3. Optionally enable **Dry run** to preview changes without applying them
4. Run the workflow

This will:
- Create the Lark department and sync org members into it
- Create a Lark group chat for each repo
- Set `LARK_CHAT_ID` as a variable on each repo

### Step 7: Deploy Notification Workflows

1. Go to **Actions** → **Setup Notification Workflows**
2. Click **Run workflow** (try dry run first)
3. This pushes `.github/workflows/lark-notify.yml` to every org repo

After this, any push, issue, PR, or release in your org repos will send a notification to the corresponding Lark group chat.

## Event Notifications

The following GitHub events generate Lark notifications:

| Event | Triggers | Card Style |
|---|---|---|
| **Push** | Commits pushed to main/master | Blue — commit list with compare link |
| **Issues** | Opened, closed, reopened, assigned, labeled | Orange/Green — issue details |
| **Issue Comments** | New comment on issue or PR | Blue — comment excerpt |
| **Pull Requests** | Opened, closed/merged, reopened, ready for review | Purple/Green/Red — PR details with stats |
| **PR Reviews** | Submitted (approved/changes requested/commented) | Green/Orange/Blue |
| **Releases** | Published | Turquoise — release notes |
| **Branch/Tag Create** | New branch or tag | Green |
| **Branch/Tag Delete** | Deleted branch or tag | Red |
| **Fork** | Repository forked | Grey |
| **Workflow Runs** | CI/CD completed (success/failure) | Green/Red |

All notifications use Lark interactive cards with clickable "View on GitHub" buttons.

## Configuration Reference

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `LARK_APP_ID` | Yes | — | Lark app ID |
| `LARK_APP_SECRET` | Yes | — | Lark app secret |
| `LARK_DOMAIN` | No | `feishu` | `feishu` (China) or `lark` (international) |
| `LARK_DEPARTMENT_NAME` | No | `GitHub Organization` | Name of the Lark department for synced members |
| `GITHUB_TOKEN` | Yes | — | GitHub PAT with org access |
| `GITHUB_ORG` | Yes | — | GitHub organization name |
| `DRY_RUN` | No | `false` | Preview changes without applying |
| `SYNC_REMOVE_MEMBERS` | No | `true` | Remove members from Lark dept when they leave the GitHub org |
| `LARK_CHAT_ID` | No | — | Override: direct Lark chat ID for notifications |

### Data Files

| File | Description |
|---|---|
| `data/repo-chat-mapping.json` | Auto-managed mapping of repo → Lark chat ID |
| `data/user-mapping.json` | Manual overrides for GitHub login → Lark email |

## Running Locally

For testing or one-off runs:

```bash
# Install dependencies
npm install

# Set environment variables
export LARK_APP_ID="cli_xxx"
export LARK_APP_SECRET="xxx"
export GITHUB_TOKEN="ghp_xxx"
export GITHUB_ORG="your-org"

# Dry run member sync
DRY_RUN=true npm run sync-members

# Dry run repo sync
DRY_RUN=true npm run sync-repos
```

## Troubleshooting

### Members not syncing

- Verify the GitHub user has a public email or is listed in `data/user-mapping.json`
- Verify the email matches their Lark account email
- Check the Lark app has `contact:contact` permission approved

### Group chats not created

- Verify the Lark app has `im:chat` permission approved
- Verify the `SYNC_GITHUB_TOKEN` has `repo` access to the org

### Notifications not arriving

- Check that `LARK_APP_ID` and `LARK_APP_SECRET` are set as org-level secrets
- Check the `LARK_CHAT_ID` variable exists on the repo (set by `sync-repos`)
- Check the workflow file exists at `.github/workflows/lark-notify.yml` in the target repo
- Look at the workflow run logs in the target repo's Actions tab

### "No Lark chat found" error

Run the sync first: go to the sync repo's Actions → "Sync GitHub → Lark" → Run workflow. This creates the group chats and sets `LARK_CHAT_ID` on each repo.

## License

MIT
