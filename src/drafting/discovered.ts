import { createHash } from "node:crypto";

/**
 * Questions the agent read off a live form that the packet did not hold, such
 * as every question on a Workday tenant. They get a key derived from the
 * label, so the same question keeps the same key on every posting and an
 * answer to it can be carried to the next application at that employer.
 */
const DISCOVERED_KEY_PREFIX = "discovered_";

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, " ");
}

export function discoveredQuestionKey(label: string): string {
  const digest = createHash("sha1").update(normalizeLabel(label)).digest("hex");
  return `${DISCOVERED_KEY_PREFIX}${digest.slice(0, 16)}`;
}

export function isDiscoveredQuestionKey(key: string): boolean {
  return key.startsWith(DISCOVERED_KEY_PREFIX);
}
