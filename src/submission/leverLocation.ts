import { z } from "zod";
import { AppError } from "../util/errors.js";
import { sameLocation } from "./place.js";

type LocationDriver = {
  search(query: string): Promise<void>;
  options(): Promise<string[]>;
  pick(index: number): Promise<void>;
  selection(): Promise<unknown>;
  hasChallenge(): Promise<boolean>;
};

const selectionSchema = z.object({ display: z.string(), encoded: z.string() });
const locationSchema = z.object({ name: z.string() });

function retainedLocationError(): AppError {
  return new AppError("location_not_verified", "Lever did not retain the selected current location");
}

async function verifySelection(ui: LocationDriver, approved: string): Promise<void> {
  const result = selectionSchema.safeParse(await ui.selection());
  if (!result.success || !result.data.encoded) throw retainedLocationError();
  let selected: unknown;
  try {
    selected = JSON.parse(result.data.encoded);
  } catch (error) {
    if (error instanceof SyntaxError) throw retainedLocationError();
    throw error;
  }
  const native = locationSchema.safeParse(selected);
  if (!native.success || !sameLocation(result.data.display, approved)
    || !sameLocation(native.data.name, approved)) throw retainedLocationError();
}

export async function fillLeverLocation(ui: LocationDriver, candidates: readonly string[]): Promise<void> {
  const queries = [...new Set(candidates.map((candidate) => candidate.trim()).filter(Boolean))];
  const approved = queries[0];
  if (!approved) throw new AppError("location_missing", "No approved current location was supplied");
  for (const query of queries) {
    if (await ui.hasChallenge()) throw new AppError("captcha_required", "Interactive CAPTCHA detected during location lookup");
    await ui.search(query);
    const options = await ui.options();
    if (await ui.hasChallenge()) throw new AppError("captcha_required", "Interactive CAPTCHA detected during location lookup");
    const index = options.findIndex((option) => sameLocation(option, approved));
    if (index < 0) continue;
    await ui.pick(index);
    await verifySelection(ui, approved);
    return;
  }
  throw new AppError("location_not_verified", "No native option matched the approved current location");
}
