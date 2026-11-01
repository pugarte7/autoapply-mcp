import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

/** Client options for a test client whose person can be asked to approve. */
export const ASKS_PERSON = { capabilities: { elicitation: {} } } as const;

/**
 * Stands in for the person behind the client: answers every approval dialog
 * with `answer`, and keeps what they were shown.
 */
export function person(client: Client, answer: () => boolean = () => true): { shown: string[] } {
  const shown: string[] = [];
  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    shown.push(String(request.params.message));
    return { action: "accept", content: { approve: answer() } };
  });
  return { shown };
}
