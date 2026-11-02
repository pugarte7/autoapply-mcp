import { LEGACY_MANUAL_MODE } from "../domain/campaign.js";

/**
 * Settings that still load but no longer mean what the file says.
 *
 * The schema maps a removed value onto its replacement so an old config keeps
 * working, which is also what makes it invisible: `"mode": "manual"` used to
 * mean nothing reaches an employer without a person sending it, and it now
 * loads as `auto`. Someone who wrote that line on purpose has to be told, so
 * `doctor` prints these as warnings rather than letting the remap go silent.
 */
export function findLegacyCampaignSettings(raw: unknown): string[] {
  const submission = isRecord(raw) && isRecord(raw.submission) ? raw.submission : undefined;
  if (submission?.mode === LEGACY_MANUAL_MODE) {
    return [
      'campaign.json: submission.mode "manual" was removed and is treated as "auto"; approved applications are submitted by the agent. Set "assisted" to press submit yourself.',
    ];
  }
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
