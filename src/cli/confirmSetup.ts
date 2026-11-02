import { createInterface } from "node:readline/promises";
import { getWorkspace } from "../config/load.js";
import { resolvePaths } from "../config/paths.js";
import { applyPending, describeChanges, dropPending, loadPending } from "../config/standing.js";
import { redraftOpenApplications } from "../drafting/redraft.js";

/**
 * `approve.js --setup <id>`: the terminal half of a standing decision staged by
 * setup_profile, update_campaign or remember_answer, for clients with no
 * approval dialog. The caller has already checked both ends are a terminal.
 * What is shown is rendered from the staged change, not from agent text.
 *
 * This is a CLI, so writing to stdout is correct here.
 */
export async function confirmSetup(id: string | undefined): Promise<number> {
  if (!id) {
    console.error("usage: approve.js --setup <changeId>");
    return 2;
  }
  const paths = resolvePaths();
  const pending = loadPending(paths, id);
  console.log(`${describeChanges(pending.changes)}\n`);
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await prompt.question('Type "yes" to make these standing, "no" to discard them: ')).trim().toLowerCase();
  prompt.close();
  if (answer === "no") {
    dropPending(paths, id);
    console.log("Discarded; these questions will keep being asked.");
    return 1;
  }
  if (answer !== "yes") {
    console.log("Not confirmed; the change is still staged.");
    return 1;
  }
  const written = applyPending(paths, pending);
  console.log(`Saved to ${written.join(", ")}.`);
  if (pending.redraftKeys.length > 0) {
    try {
      const workspace = getWorkspace();
      const updated = redraftOpenApplications(workspace.db, workspace.profile, workspace.campaign, pending.redraftKeys);
      console.log(`Applications updated: ${updated.length}`);
    } catch (error) {
      console.log(`Saved, but open applications were not updated: ${String(error)}`);
    }
  }
  return 0;
}
