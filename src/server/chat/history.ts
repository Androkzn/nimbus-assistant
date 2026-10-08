import "server-only";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { neon } from "@neondatabase/serverless";
import type { ConversationSummary, StoredConversation, StoredTurn } from "@/shared/history";

type Row = Record<string, unknown>;

const DB_ROOT = process.env.VERCEL ? "/tmp" : path.join(process.cwd(), ".data");
const DB_FILE = process.env.NIMBUS_CHAT_DB_PATH ?? path.join(DB_ROOT, "nimbus-chat.sqlite");
const DATABASE_URL = process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? process.env.NEON_DATABASE_URL ?? "";
const sharedSql = DATABASE_URL ? neon(DATABASE_URL) : null;
let database: DatabaseSync | null = null;
let sharedReady: Promise<void> | null = null;

function sqlite(): DatabaseSync {
  if (database) return database;
  mkdirSync(path.dirname(DB_FILE), { recursive: true });
  database = new DatabaseSync(DB_FILE);
  database.exec(`
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      title TEXT NOT NULL,
      turns_json TEXT NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS conversations_owner_updated_idx ON conversations(owner_id, updated_at DESC);
  `);
  return database;
}

async function ensureShared(): Promise<void> {
  if (!sharedSql) return;
  if (!sharedReady) {
    sharedReady = sharedSql`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        title TEXT NOT NULL,
        turns_json TEXT NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )
    `
      .then(() => sharedSql`CREATE INDEX IF NOT EXISTS conversations_owner_updated_idx ON conversations(owner_id, updated_at DESC)`)
      .then(() => undefined)
      .catch((error) => {
        sharedReady = null;
        throw error;
      });
  }
  await sharedReady;
}

function summary(row: Row): ConversationSummary {
  return {
    id: String(row.id),
    title: String(row.title),
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
    messageCount: Number(row.message_count ?? 0),
  };
}

function conversation(row: Row): StoredConversation {
  let turns: StoredTurn[] = [];
  try {
    const parsed = JSON.parse(String(row.turns_json)) as unknown;
    if (Array.isArray(parsed)) turns = parsed as StoredTurn[];
  } catch {
    turns = [];
  }
  return { ...summary(row), turns };
}

function normalizeTurns(turns: StoredTurn[]): StoredTurn[] {
  return turns
    .slice(-20)
    .filter((turn) => turn && typeof turn.id === "string" && typeof turn.question === "string" && turn.answer)
    .map((turn) => ({
      id: turn.id.slice(0, 100),
      question: turn.question.trim().slice(0, 2000),
      answer: turn.answer,
    }));
}

export async function listConversations(ownerId: string): Promise<ConversationSummary[]> {
  if (!sharedSql) {
    return (sqlite().prepare("SELECT * FROM conversations WHERE owner_id = ? ORDER BY updated_at DESC").all(ownerId) as Row[]).map(summary);
  }
  await ensureShared();
  const rows = (await sharedSql`SELECT * FROM conversations WHERE owner_id = ${ownerId} ORDER BY updated_at DESC`) as Row[];
  return rows.map(summary);
}

export async function getConversation(ownerId: string, id: string): Promise<StoredConversation | null> {
  if (!sharedSql) {
    const row = sqlite().prepare("SELECT * FROM conversations WHERE owner_id = ? AND id = ?").get(ownerId, id) as Row | undefined;
    return row ? conversation(row) : null;
  }
  await ensureShared();
  const rows = (await sharedSql`SELECT * FROM conversations WHERE owner_id = ${ownerId} AND id = ${id}`) as Row[];
  return rows[0] ? conversation(rows[0]) : null;
}

export async function saveConversation(ownerId: string, id: string | null, turns: StoredTurn[]): Promise<StoredConversation> {
  const cleanTurns = normalizeTurns(turns);
  const conversationId = id && /^[0-9a-f-]{36}$/i.test(id) ? id : crypto.randomUUID();
  const title = cleanTurns[0]?.question.slice(0, 80) || "New conversation";
  const now = new Date().toISOString();
  const turnsJson = JSON.stringify(cleanTurns);
  const messageCount = cleanTurns.length * 2;

  if (!sharedSql) {
    const target = sqlite();
    const existing = target.prepare("SELECT id, created_at FROM conversations WHERE owner_id = ? AND id = ?").get(ownerId, conversationId) as Row | undefined;
    if (existing) {
      target.prepare("UPDATE conversations SET title = ?, turns_json = ?, message_count = ?, updated_at = ? WHERE owner_id = ? AND id = ?").run(title, turnsJson, messageCount, now, ownerId, conversationId);
    } else {
      target.prepare("INSERT INTO conversations (id, owner_id, title, turns_json, message_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(conversationId, ownerId, title, turnsJson, messageCount, now, now);
    }
    return (await getConversation(ownerId, conversationId))!;
  }

  await ensureShared();
  const rows = (await sharedSql`
    INSERT INTO conversations (id, owner_id, title, turns_json, message_count, created_at, updated_at)
    VALUES (${conversationId}, ${ownerId}, ${title}, ${turnsJson}, ${messageCount}, ${now}, ${now})
    ON CONFLICT (id) DO UPDATE SET title = ${title}, turns_json = ${turnsJson}, message_count = ${messageCount}, updated_at = ${now}
    WHERE conversations.owner_id = ${ownerId}
    RETURNING *
  `) as Row[];
  if (!rows[0]) throw new Error("Conversation could not be saved.");
  return conversation(rows[0]);
}

export async function deleteConversation(ownerId: string, id: string): Promise<boolean> {
  if (!sharedSql) return Number(sqlite().prepare("DELETE FROM conversations WHERE owner_id = ? AND id = ?").run(ownerId, id).changes) > 0;
  await ensureShared();
  const rows = (await sharedSql`DELETE FROM conversations WHERE owner_id = ${ownerId} AND id = ${id} RETURNING id`) as Row[];
  return rows.length > 0;
}
