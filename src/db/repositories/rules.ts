import type { Db } from "../database.js";
import { jsonOrDefault } from "../database.js";
import type { StandingRules } from "../../submission/standingRules.js";
import { nowIso } from "../../util/hash.js";

/** Storage for standing rules and the submissions they authorised. */

export type ApprovedVia = "dialog" | "cli";

export type StandingRulesRecord = {
  id: string;
  rules: StandingRules;
  hash: string;
  createdAt: string;
  expiresAt: string;
  approvedAt: string | null;
  approvedVia: ApprovedVia | null;
  revokedAt: string | null;
};

type Row = Record<string, unknown>;

function rowToRecord(row: Row): StandingRulesRecord {
  return {
    id: String(row.id),
    rules: jsonOrDefault<StandingRules>(row.rules_json, {} as StandingRules),
    hash: String(row.rules_hash),
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
    approvedAt: row.approved_at ? String(row.approved_at) : null,
    approvedVia: row.approved_via ? (String(row.approved_via) as ApprovedVia) : null,
    revokedAt: row.revoked_at ? String(row.revoked_at) : null,
  };
}

export function proposeRules(db: Db, id: string, rules: StandingRules, hash: string): void {
  db.prepare(
    "INSERT INTO standing_rules (id, rules_json, rules_hash, created_at, expires_at) VALUES (?,?,?,?,?)",
  ).run(id, JSON.stringify(rules), hash, nowIso(), rules.expiresAt);
}

export function getRules(db: Db, id: string): StandingRulesRecord | null {
  const row = db.prepare("SELECT * FROM standing_rules WHERE id = ?").get(id) as Row | undefined;
  return row ? rowToRecord(row) : null;
}

export function listRules(db: Db, limit = 50): StandingRulesRecord[] {
  const rows = db.prepare("SELECT * FROM standing_rules ORDER BY created_at DESC LIMIT ?").all(limit) as Row[];
  return rows.map(rowToRecord);
}

/** Approved, not revoked and not expired, newest first. */
export function listActiveRules(db: Db, now = new Date()): StandingRulesRecord[] {
  const rows = db
    .prepare(
      `SELECT * FROM standing_rules
       WHERE approved_at IS NOT NULL AND revoked_at IS NULL AND expires_at > ?
       ORDER BY approved_at DESC`,
    )
    .all(now.toISOString()) as Row[];
  return rows.map(rowToRecord);
}

export function markRulesApproved(db: Db, id: string, via: ApprovedVia): void {
  db.prepare("UPDATE standing_rules SET approved_at = ?, approved_via = ? WHERE id = ? AND approved_at IS NULL").run(
    nowIso(),
    via,
    id,
  );
}

export function markRulesRevoked(db: Db, id: string): void {
  db.prepare("UPDATE standing_rules SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(nowIso(), id);
}

export function recordRulesUse(db: Db, rulesId: string, applicationId: string): void {
  db.prepare("INSERT INTO standing_rule_uses (rules_id, application_id, used_at) VALUES (?,?,?)").run(
    rulesId,
    applicationId,
    nowIso(),
  );
}

export function countRulesUsesSince(db: Db, rulesId: string, isoTimestamp: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS total FROM standing_rule_uses WHERE rules_id = ? AND used_at >= ?")
    .get(rulesId, isoTimestamp) as Row | undefined;
  return Number(row?.total ?? 0);
}
