import * as lark from '@larksuiteoapi/node-sdk';
import type { Config } from './config.js';
import type { LarkDepartment, LarkMember } from './types.js';

let client: lark.Client;

export function initLarkClient(config: Config): lark.Client {
  client = new lark.Client({
    appId: config.larkAppId,
    appSecret: config.larkAppSecret,
    appType: lark.AppType.SelfBuild,
    domain: config.larkDomain,
  });
  return client;
}

/** Create a Lark client directly from app credentials (for the setup wizard). */
export function initLarkClientDirect(
  appId: string,
  appSecret: string,
  domain: typeof lark.Domain.Feishu | typeof lark.Domain.Lark,
): lark.Client {
  client = new lark.Client({
    appId,
    appSecret,
    appType: lark.AppType.SelfBuild,
    domain,
  });
  return client;
}

export function getLarkClient(): lark.Client {
  if (!client) throw new Error('Lark client not initialized — call initLarkClient first');
  return client;
}

// ---------------------------------------------------------------------------
// Department helpers
// ---------------------------------------------------------------------------

/** Find a department by name under the root. Returns open_department_id or null. */
export async function findDepartmentByName(name: string): Promise<string | null> {
  const c = getLarkClient();
  let pageToken: string | undefined;

  do {
    const res = await c.contact.department.list({
      params: {
        parent_department_id: '0',
        fetch_child: true,
        page_size: 50,
        page_token: pageToken,
        department_id_type: 'open_department_id',
      },
    });

    const items = res?.data?.items ?? [];
    for (const dept of items) {
      if (dept.name === name) {
        return dept.open_department_id ?? null;
      }
    }
    pageToken = res?.data?.page_token ?? undefined;
  } while (pageToken);

  return null;
}

/** Create a department under the root. Returns the open_department_id. */
export async function createDepartment(name: string): Promise<string> {
  const c = getLarkClient();
  const res = await c.contact.department.create({
    data: {
      name,
      parent_department_id: '0',
    },
    params: {
      department_id_type: 'open_department_id',
    },
  });

  const deptId = res?.data?.department?.open_department_id;
  if (!deptId) throw new Error(`Failed to create department "${name}": ${JSON.stringify(res)}`);
  return deptId;
}

/** Get or create a department by name. */
export async function getOrCreateDepartment(name: string): Promise<string> {
  const existing = await findDepartmentByName(name);
  if (existing) {
    console.log(`  Department "${name}" already exists: ${existing}`);
    return existing;
  }
  console.log(`  Creating department "${name}"...`);
  const id = await createDepartment(name);
  console.log(`  Created department "${name}": ${id}`);
  return id;
}

// ---------------------------------------------------------------------------
// User helpers
// ---------------------------------------------------------------------------

/** Look up Lark user open_ids by their email addresses. Returns a map of email → open_id. */
export async function batchGetUserIdsByEmail(emails: string[]): Promise<Map<string, string>> {
  const c = getLarkClient();
  const result = new Map<string, string>();
  if (emails.length === 0) return result;

  // API allows up to 50 emails per call
  for (let i = 0; i < emails.length; i += 50) {
    const batch = emails.slice(i, i + 50);
    const res = await c.contact.user.batchGetId({
      data: { emails: batch },
      params: { user_id_type: 'open_id' },
    });

    const list = res?.data?.user_list ?? [];
    for (const item of list) {
      if (item.email && item.user_id) {
        result.set(item.email, item.user_id);
      }
    }
  }
  return result;
}

/** List all user open_ids in a department. */
export async function listDepartmentMembers(departmentId: string): Promise<string[]> {
  const c = getLarkClient();
  const members: string[] = [];
  let pageToken: string | undefined;

  do {
    const res = await c.contact.user.findByDepartment({
      params: {
        department_id: departmentId,
        department_id_type: 'open_department_id',
        user_id_type: 'open_id',
        page_size: 50,
        page_token: pageToken,
      },
    });

    const items = res?.data?.items ?? [];
    for (const user of items) {
      if (user.open_id) members.push(user.open_id);
    }
    pageToken = res?.data?.page_token ?? undefined;
  } while (pageToken);

  return members;
}

// ---------------------------------------------------------------------------
// Group chat helpers
// ---------------------------------------------------------------------------

/** Create a group chat. Returns chat_id. */
export async function createGroupChat(
  name: string,
  description: string,
  memberOpenIds?: string[],
): Promise<string> {
  const c = getLarkClient();
  const res = await c.im.chat.create({
    data: {
      name,
      description,
      chat_mode: 'group',
      chat_type: 'private',
      user_id_list: memberOpenIds,
    },
    params: {
      user_id_type: 'open_id',
      set_bot_manager: true,
    },
  });

  const chatId = res?.data?.chat_id;
  if (!chatId) throw new Error(`Failed to create group chat "${name}": ${JSON.stringify(res)}`);
  return chatId;
}

/** List all group chats the bot is in. Returns a map of chat_name → chat_id. */
export async function listBotChats(): Promise<Map<string, string>> {
  const c = getLarkClient();
  const chats = new Map<string, string>();
  let pageToken: string | undefined;

  do {
    const res = await c.im.chat.list({
      params: {
        page_size: 100,
        page_token: pageToken,
        sort_type: 'ByCreateTimeAsc',
      },
    });

    const items = res?.data?.items ?? [];
    for (const chat of items) {
      if (chat.name && chat.chat_id) {
        chats.set(chat.name, chat.chat_id);
      }
    }
    pageToken = res?.data?.page_token ?? undefined;
  } while (pageToken);

  return chats;
}

/** Add members to a group chat. */
export async function addMembersToChat(chatId: string, openIds: string[]): Promise<void> {
  if (openIds.length === 0) return;
  const c = getLarkClient();

  // API allows up to 50 members per call
  for (let i = 0; i < openIds.length; i += 50) {
    const batch = openIds.slice(i, i + 50);
    await c.im.chatMembers.create({
      data: { id_list: batch },
      params: { member_id_type: 'open_id' },
      path: { chat_id: chatId },
    });
  }
}

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

/** Send an interactive card message to a chat. */
export async function sendCardMessage(chatId: string, card: object): Promise<void> {
  const c = getLarkClient();
  await c.im.message.create({
    data: {
      receive_id: chatId,
      msg_type: 'interactive',
      content: JSON.stringify(card),
    },
    params: {
      receive_id_type: 'chat_id',
    },
  });
}

/** Send a plain text message to a chat. */
export async function sendTextMessage(chatId: string, text: string): Promise<void> {
  const c = getLarkClient();
  await c.im.message.create({
    data: {
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    },
    params: {
      receive_id_type: 'chat_id',
    },
  });
}

// ---------------------------------------------------------------------------
// Department listing (for setup wizard)
// ---------------------------------------------------------------------------

/** List child departments under a parent. Use "0" for root. */
export async function listDepartments(parentId = '0'): Promise<LarkDepartment[]> {
  const c = getLarkClient();
  const departments: LarkDepartment[] = [];
  let pageToken: string | undefined;

  do {
    const res = await c.contact.department.list({
      params: {
        parent_department_id: parentId,
        fetch_child: true,
        page_size: 50,
        page_token: pageToken,
        department_id_type: 'open_department_id',
      },
    });

    const items = res?.data?.items ?? [];
    for (const dept of items) {
      departments.push({
        department_id: dept.open_department_id ?? '',
        name: dept.name ?? '',
        member_count: (dept as any).member_count ?? null,
        parent_department_id: dept.parent_department_id ?? '0',
      });
    }
    pageToken = res?.data?.page_token ?? undefined;
  } while (pageToken);

  return departments;
}

// ---------------------------------------------------------------------------
// Detailed member listing (for bidirectional sync)
// ---------------------------------------------------------------------------

/** List all members in a department with their name, email, and department IDs. */
export async function listDepartmentMembersDetailed(
  departmentId: string,
): Promise<LarkMember[]> {
  const c = getLarkClient();
  const members: LarkMember[] = [];
  let pageToken: string | undefined;

  do {
    const res = await c.contact.user.findByDepartment({
      params: {
        department_id: departmentId,
        department_id_type: 'open_department_id',
        user_id_type: 'open_id',
        page_size: 50,
        page_token: pageToken,
      },
    });

    const items = res?.data?.items ?? [];
    for (const user of items) {
      if (user.open_id) {
        members.push({
          open_id: user.open_id,
          name: user.name ?? '',
          email: user.email ?? user.enterprise_email ?? null,
          department_ids: user.department_ids ?? [],
        });
      }
    }
    pageToken = res?.data?.page_token ?? undefined;
  } while (pageToken);

  return members;
}

/** Verify that the Lark credentials are valid by fetching the tenant token. */
export async function verifyCredentials(): Promise<boolean> {
  try {
    // A lightweight call to verify the app credentials work
    await getLarkClient().contact.department.list({
      params: { parent_department_id: '0', page_size: 1 },
    });
    return true;
  } catch {
    return false;
  }
}
