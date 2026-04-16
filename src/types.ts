/** Mapping from GitHub repo full name (org/repo) to Lark chat ID */
export interface RepoChatMapping {
  [repoFullName: string]: {
    chat_id: string;
    chat_name: string;
    created_at: string;
  };
}

/** Manual mapping overrides: GitHub login → Lark email */
export interface UserMapping {
  [githubLogin: string]: string;
}

/** A GitHub org member with optional email */
export interface GitHubMember {
  login: string;
  email: string | null;
  avatar_url: string;
  html_url: string;
}

/** A GitHub repo summary */
export interface GitHubRepo {
  name: string;
  full_name: string;
  description: string | null;
  html_url: string;
  private: boolean;
  default_branch: string;
}

/** Result of a member sync operation */
export interface MemberSyncResult {
  added: string[];
  removed: string[];
  skipped: string[];
  errors: string[];
}

/** Result of a repo sync operation */
export interface RepoSyncResult {
  created: string[];
  existing: string[];
  errors: string[];
}

/** Supported GitHub event types for notifications */
export type GitHubEventType =
  | 'push'
  | 'issues'
  | 'issue_comment'
  | 'pull_request'
  | 'pull_request_review'
  | 'release'
  | 'create'
  | 'delete'
  | 'fork'
  | 'star'
  | 'workflow_run';
