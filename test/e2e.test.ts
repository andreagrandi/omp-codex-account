import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension, {
  OmpAgentDbStorage,
  resolveActiveStorage,
  type CodexCredential,
} from "../src/index";

type FakeContext = {
  ui: {
    setStatus: (id: string, value: string | undefined) => void;
    notify: (message: string, level: string) => void;
  };
  reload: () => Promise<void>;
};

type SessionHandler = (event: unknown, ctx: FakeContext) => void | Promise<void>;
type RegisteredCommand = {
  handler: (args: string, ctx: FakeContext) => void | Promise<void>;
};

type FakeExtensionApi = Parameters<typeof extension>[0];

const credential = (suffix: string): CodexCredential => ({
  type: "oauth",
  access: `fixture-access-${suffix.toLowerCase()}`,
  refresh: `fixture-refresh-${suffix.toLowerCase()}`,
  expires: 0,
  accountId: `acct-${suffix.toLowerCase()}`,
  email: `${suffix.toLowerCase()}@example.test`,
});

function createOmpDb(path: string): void {
  const db = new Database(path);
  db.run(`CREATE TABLE auth_credentials (
    id INTEGER PRIMARY KEY,
    provider TEXT NOT NULL,
    credential_type TEXT NOT NULL,
    data TEXT NOT NULL,
    disabled_cause TEXT,
    identity_key TEXT,
    created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
    updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
  )`);
  db.run(`CREATE TABLE auth_credential_blocks (
    credential_id INTEGER NOT NULL,
    provider_key TEXT NOT NULL,
    block_scope TEXT NOT NULL DEFAULT '',
    blocked_until_ms INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (credential_id, provider_key, block_scope)
  )`);
  db.close();
}

function insertCredential(path: string, id: number, value: CodexCredential): void {
  const db = new Database(path);
  (db.run as unknown as (query: string, ...params: unknown[]) => void)(
    `INSERT INTO auth_credentials
      (id, provider, credential_type, data, identity_key, updated_at)
     VALUES (?, 'openai-codex', 'oauth', ?, ?, ?)`,
    id,
    JSON.stringify(value),
    `account:${value.accountId}`,
    Math.floor(Date.now() / 1000) + id,
  );
  db.close();
}

function writeSnapshot(
  directory: string,
  label: string,
  value: CodexCredential,
  savedAt: number,
): void {
  writeFileSync(
    join(directory, `${label}.json`),
    JSON.stringify({
      row: {
        provider: "openai-codex",
        credential_type: "oauth",
        data: { ...value },
        identity_key: value.accountId ? `account:${value.accountId}` : null,
        disabled_cause: null,
      },
      credential: value,
      savedAt,
    }),
  );
}

function readActiveRow(path: string): {
  provider: string;
  credential_type: string;
  data: string;
  identity_key: string | null;
  disabled_cause: string | null;
} {
  const db = new Database(path, { readonly: true });
  const row = db
    .query(
      `SELECT provider, credential_type, data, identity_key, disabled_cause
       FROM auth_credentials
       WHERE provider = 'openai-codex'
       ORDER BY id DESC
       LIMIT 1`,
    )
    .get() as {
    provider: string;
    credential_type: string;
    data: string;
    identity_key: string | null;
    disabled_cause: string | null;
  };
  db.close();
  return row;
}

let agentDir = "";
let previousEnv: NodeJS.ProcessEnv = {};
let previousFetch: typeof fetch;

beforeEach(() => {
  previousEnv = { ...process.env };
  previousFetch = globalThis.fetch;

  agentDir = mkdtempSync(join(tmpdir(), "pi-codex-e2e-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.OMP_AGENT_DB_PATH = join(agentDir, "agent.db");
  process.env.OMP_CODEX_ACCOUNTS_DIR = join(agentDir, "omp-codex-accounts");

  globalThis.fetch = (async () => {
    throw new Error("network access is not part of this E2E flow");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in previousEnv)) delete process.env[key];
  }
  Object.assign(process.env, previousEnv);
  globalThis.fetch = previousFetch;
  rmSync(agentDir, { recursive: true, force: true });
});

describe("extension end-to-end flow", () => {
  test("restores status, switches credentials, and reloads once", async () => {
    const dbPath = process.env.OMP_AGENT_DB_PATH!;
    const accountsDir = process.env.OMP_CODEX_ACCOUNTS_DIR!;
    const home = credential("HOME");
    const work = credential("WORK");

    mkdirSync(accountsDir, { recursive: true });
    createOmpDb(dbPath);
    insertCredential(dbPath, 1, home);
    writeSnapshot(accountsDir, "home", home, 2);
    writeSnapshot(accountsDir, "work", work, 1);
    writeFileSync(join(accountsDir, "active-label"), "home");

    expect(resolveActiveStorage()).toBeInstanceOf(OmpAgentDbStorage);

    const lifecycle = new Map<string, SessionHandler>();
    const commands = new Map<string, RegisteredCommand>();
    const api = {
      on(event: string, handler: SessionHandler) {
        lifecycle.set(event, handler);
      },
      registerCommand(name: string, command: RegisteredCommand) {
        commands.set(name, command);
      },
    } as unknown as FakeExtensionApi;
    extension(api);

    expect(lifecycle.get("session_start")).toBeDefined();
    expect(lifecycle.get("session_shutdown")).toBeDefined();
    expect(commands.get("codex")).toBeDefined();

    const statusCalls: Array<{ id: string; value: string | undefined }> = [];
    const notifications: string[] = [];
    const events: string[] = [];
    let reloadCount = 0;
    const ctx: FakeContext = {
      ui: {
        setStatus(id, value) {
          statusCalls.push({ id, value });
          events.push(`status:${id}:${value ?? "undefined"}`);
        },
        notify(message) {
          notifications.push(message);
        },
      },
      async reload() {
        events.push("reload");
        reloadCount += 1;
        events.push("reload:session_shutdown");
        await lifecycle.get("session_shutdown")!(undefined, ctx);
        events.push("reload:session_start");
        await lifecycle.get("session_start")!(undefined, ctx);
      },
    };

    const sessionStart = lifecycle.get("session_start");
    expect(sessionStart).toBeDefined();
    events.push("initial:session_start");
    await sessionStart!(undefined, ctx);
    expect(statusCalls).toContainEqual({
      id: "codex-accounts-usage",
      value: undefined,
    });
    expect(statusCalls).toContainEqual({
      id: "codex-account",
      value: "Codex: home",
    });
    expect(events.indexOf("status:codex-accounts-usage:undefined")).toBeLessThan(
      events.indexOf("status:codex-account:Codex: home"),
    );

    const command = commands.get("codex");
    expect(command).toBeDefined();
    await command!.handler("switch work", ctx);

    const activeRow = readActiveRow(dbPath);
    const activeData = JSON.parse(activeRow.data) as Record<string, unknown>;
    expect(activeRow).toMatchObject({
      provider: "openai-codex",
      credential_type: "oauth",
      identity_key: `account:${work.accountId}`,
      disabled_cause: null,
    });
    expect(activeData).toMatchObject({
      type: "oauth",
      access: work.access,
      refresh: work.refresh,
      accountId: work.accountId,
      email: work.email,
      expires: work.expires,
    });
    expect(work.expires).toBe(0);

    expect(statusCalls).toContainEqual({
      id: "codex-account",
      value: "Codex: work",
    });
    expect(events.indexOf("status:codex-account:Codex: work")).toBeLessThan(
      events.indexOf("reload"),
    );
    expect(events.indexOf("reload")).toBeLessThan(
      events.indexOf("reload:session_shutdown"),
    );
    expect(events.indexOf("reload:session_shutdown")).toBeLessThan(
      events.indexOf("reload:session_start"),
    );

    const accountStatusCalls = statusCalls.filter(({ id }) => id === "codex-account");
    expect(accountStatusCalls[accountStatusCalls.length - 1]).toEqual({
      id: "codex-account",
      value: "Codex: work",
    });
    expect(reloadCount).toBe(1);
    expect(
      notifications.some((message) => message.includes("Switched to Codex account \"work\"")),
    ).toBe(true);
    const reloadsBeforeSave = reloadCount;
    await command!.handler("save office", ctx);

    expect(statusCalls[statusCalls.length - 1]).toEqual({
      id: "codex-account",
      value: "Codex: office",
    });
    expect(reloadCount).toBe(reloadsBeforeSave);
  });
});
