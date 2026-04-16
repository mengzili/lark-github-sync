import * as lark from '@larksuiteoapi/node-sdk';

export interface Config {
  // Lark / Feishu
  larkAppId: string;
  larkAppSecret: string;
  larkDomain: typeof lark.Domain.Feishu | typeof lark.Domain.Lark;

  // The Lark department whose members map to the GitHub org.
  // Use "0" for the root (entire company).
  larkSourceDepartmentId: string;

  // GitHub
  githubToken: string;
  githubOrg: string;

  // Options
  dryRun: boolean;
  syncRemoveMembers: boolean;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value;
}

export function loadConfig(): Config {
  return {
    larkAppId: requiredEnv('LARK_APP_ID'),
    larkAppSecret: requiredEnv('LARK_APP_SECRET'),
    larkDomain:
      process.env.LARK_DOMAIN === 'lark'
        ? lark.Domain.Lark
        : lark.Domain.Feishu,
    larkSourceDepartmentId:
      process.env.LARK_SOURCE_DEPARTMENT_ID || '0',

    githubToken: requiredEnv('GITHUB_TOKEN'),
    githubOrg: requiredEnv('GITHUB_ORG'),

    dryRun: process.env.DRY_RUN === 'true',
    syncRemoveMembers: process.env.SYNC_REMOVE_MEMBERS !== 'false',
  };
}
