import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getWorkspace } from "../config/load.js";
import { appendEvent } from "../db/repositories/events.js";
import { countRulesUsesSince, getRules, listRules, markRulesRevoked, type StandingRulesRecord } from "../db/repositories/rules.js";
import { askPerson, proposeStandingRules, recordRulesApproval, rulesQuestion } from "../submission/approvals.js";
import { startOfDayIso } from "../submission/guards.js";
import { StandingRulesSchema } from "../submission/standingRules.js";
import { AppError } from "../util/errors.js";
import { handler, ok } from "./helpers.js";

/**
 * Standing rules: one decision by the person that covers every packet fitting
 * it. The model proposes the rules; only the person's answer, in the client's
 * dialog or their own terminal, makes them count.
 */

function status(record: StandingRulesRecord, now = Date.now()): string {
  if (record.revokedAt) return "revoked";
  if (new Date(record.expiresAt).getTime() <= now) return "expired";
  return record.approvedAt ? "active" : "proposed";
}

export function registerRulesTools(server: McpServer): void {
  server.registerTool(
    "approve_rules",
    {
      title: "Ask the person to approve standing rules",
      description:
        "Proposes standing rules and asks the person to approve them through the client's approval dialog. Once approved, applications that match them (tier, score, track, company, board, caps) can be submitted without a per-packet approval, until they expire (30 days by default, at most 90) or are revoked. Questions only the person can answer still need an answer they recorded in the profile. Without a dialog, returns the command the person runs in their own terminal.",
      inputSchema: StandingRulesSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    handler(async (args: unknown) => {
      const { rulesId, hash, rules } = proposeStandingRules(args);
      const yes = await askPerson(server, rulesQuestion(rulesId, hash), `rules ${rulesId} ${hash}`);
      if (!yes) {
        const workspace = getWorkspace();
        // A declined proposal must not stay approvable from the terminal later.
        markRulesRevoked(workspace.db, rulesId);
        appendEvent(workspace.db, "rules.declined", rulesId, { hash });
        return ok({ rulesId, approved: false, nextStep: "The person did not approve these rules. Ask what to change; nothing was recorded." });
      }
      return ok({ ...recordRulesApproval(rulesId, hash, "dialog"), rules });
    }),
  );

  server.registerTool(
    "list_rules",
    {
      title: "List standing rules",
      description: "Standing rules with their status (proposed, active, expired, revoked), how they were approved and how many submissions they authorised today.",
      inputSchema: { limit: z.number().int().positive().max(100).optional() },
      annotations: { readOnlyHint: true },
    },
    handler(async (args: { limit?: number }) => {
      const workspace = getWorkspace();
      const since = startOfDayIso();
      return ok({
        rules: listRules(workspace.db, args.limit ?? 20).map((record) => ({
          rulesId: record.id,
          status: status(record),
          rules: record.rules,
          hash: record.hash,
          createdAt: record.createdAt,
          approvedAt: record.approvedAt,
          approvedVia: record.approvedVia,
          expiresAt: record.expiresAt,
          revokedAt: record.revokedAt,
          usedToday: countRulesUsesSince(workspace.db, record.id, since),
        })),
      });
    }),
  );

  server.registerTool(
    "revoke_rules",
    {
      title: "Revoke standing rules",
      description: "Ends a set of standing rules at once. Narrowing what may be sent needs no confirmation.",
      inputSchema: { rulesId: z.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    handler(async (args: { rulesId: string }) => {
      const workspace = getWorkspace();
      const record = getRules(workspace.db, args.rulesId);
      if (!record) throw new AppError("rules_not_found", `no standing rules ${args.rulesId}`);
      markRulesRevoked(workspace.db, record.id);
      appendEvent(workspace.db, "rules.revoked", record.id, {});
      return ok({ rulesId: record.id, status: "revoked", revokedAt: getRules(workspace.db, record.id)?.revokedAt });
    }),
  );
}
