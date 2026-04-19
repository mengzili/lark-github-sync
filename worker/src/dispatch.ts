/**
 * Fire a GitHub `repository_dispatch` event at a sync repo.
 * Used to hand off work from the worker to Actions workflows.
 */

export async function dispatchRepoEvent(opts: {
  syncRepo: string;     // "owner/repo"
  pat: string;          // fine-grained PAT with actions:write on syncRepo
  eventType: string;
  clientPayload: unknown;
}): Promise<void> {
  const res = await fetch(
    `https://api.github.com/repos/${opts.syncRepo}/dispatches`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${opts.pat}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'lark-github-sync-worker',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        event_type: opts.eventType,
        client_payload: opts.clientPayload,
      }),
    },
  );
  if (!res.ok) {
    throw new Error(`dispatch ${opts.eventType} to ${opts.syncRepo}: ${res.status} ${await res.text()}`);
  }
}
