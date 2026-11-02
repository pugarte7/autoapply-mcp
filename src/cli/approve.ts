#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import {
  applicationQuestion,
  batchQuestion,
  checkBatchManifest,
  packetFor,
  recordApplicationDecision,
  recordBatchApproval,
  recordRulesApproval,
  rulesQuestion,
} from "../submission/approvals.js";
import { AppError, toErrorMessage } from "../util/errors.js";
import { confirmSetup } from "./confirmSetup.js";

/**
 * Approval from the person's own terminal, for MCP clients that cannot show an
 * approval dialog:
 *
 *   node dist/cli/approve.js <applicationId> <packetHash>
 *   node dist/cli/approve.js --batch <batchId> <manifestHash> <count>
 *   node dist/cli/approve.js --setup <changeId>
 *   node dist/cli/approve.js rules <rulesId> <rulesHash>
 *
 * It shows what would be sent and records an approval only on a typed "yes".
 * It will not run without a terminal on both ends, which is what keeps an
 * agent's shell tool from answering for the person.
 *
 * This is a CLI, so writing to stdout is correct here.
 */

const USAGE = [
  "usage: approve.js <applicationId> <packetHash>",
  "       approve.js --batch <batchId> <manifestHash> <count>",
  "       approve.js rules <rulesId> <rulesHash>",
].join("\n");
const NOTE = "approved in the terminal";

async function main(argv: string[]): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("Run this in your own terminal: an approval is the person's to give, not an agent's.");
    return 1;
  }
  if (argv[0] === "--setup") return confirmSetup(argv[1]);
  const batch = argv[0] === "--batch";
  const rules = argv[0] === "rules";
  const [id, hash, count] = batch || rules ? argv.slice(1) : argv;
  if (!id || !hash || (batch && !count)) {
    console.error(USAGE);
    return 2;
  }

  let question: string;
  if (rules) {
    question = rulesQuestion(id, hash);
  } else if (batch) {
    checkBatchManifest(id, hash, Number(count));
    question = batchQuestion(id);
  } else {
    const { packet, currentHash } = packetFor(id);
    if (hash !== currentHash) {
      throw new AppError("packet_hash_mismatch", `the packet changed since it was previewed (current: ${currentHash})`);
    }
    question = applicationQuestion(packet, currentHash);
  }

  console.log(`${question}\n`);
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await prompt.question('Type "yes" to approve: ')).trim().toLowerCase();
  prompt.close();
  if (answer !== "yes") {
    console.log("Not approved; nothing was recorded.");
    return 1;
  }
  const result = rules
    ? recordRulesApproval(id, hash, "cli")
    : batch
    ? recordBatchApproval(id, hash, Number(count), NOTE)
    : recordApplicationDecision(id, hash, "approved", NOTE);
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(toErrorMessage(error));
    process.exit(1);
  },
);
