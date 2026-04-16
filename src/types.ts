/** Mapping from GitHub repo full name (org/repo) to Lark chat ID */
export interface RepoChatMapping {
  [repoFullName: string]: {
    chat_id: string;
    chat_name: string;
    created_at: string;
  };
}

/** A Lark department member with identity info */
export interface LarkMember {
  open_id: string;
  name: string;
  email: string | null;
  department_ids: string[];
}

/** A GitHub org member with optional email */
export interface GitHubMember {
  login: string;
  email: string | null;
  avatar_url: string;
  html_url: string;
}

/** A Lark department summary */
export interface LarkDepartment {
  department_id: string;
  name: string;
  member_count: number | null;
  parent_department_id: string;
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
  invited: string[];
  removed: string[];
  alreadySynced: string[];
  unmatchable: string[];
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
