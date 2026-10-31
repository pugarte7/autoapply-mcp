import { normalizeForMatch } from "../text/html.js";

/**
 * Countries as boards write them, keyed by normalized spelling. Lever renders
 * ISO 3166-1 alpha-3 ("Madrid, ESP", "Vancouver, BC, CAN") while a profile
 * states the country's name ("Madrid, Madrid, Spain"), and without an alias
 * the one correct suggestion was rejected as a different place: US Mobile's
 * form left a required location blank with "Madrid, ESP" on screen. A code
 * needs no entry of its own; an unknown spelling stands for itself.
 */
const COUNTRY_ALIASES: Record<string, string> = {
  "canada": "can", "ca": "can",
  "united states": "usa", "united states of america": "usa", "us": "usa", "u s a": "usa",
  "united kingdom": "gbr", "uk": "gbr", "gb": "gbr",
  "spain": "esp", "es": "esp",
  "germany": "deu", "deutschland": "deu",
  "france": "fra",
  "italy": "ita", "italia": "ita",
  "portugal": "prt",
  "netherlands": "nld", "holland": "nld",
  "ireland": "irl",
  "poland": "pol",
  "romania": "rou",
  "bulgaria": "bgr",
  "hungary": "hun",
  "ukraine": "ukr",
  "greece": "grc",
  "croatia": "hrv",
  "serbia": "srb",
  "slovakia": "svk",
  "slovenia": "svn",
  "czechia": "cze", "czech republic": "cze",
  "sweden": "swe",
  "norway": "nor",
  "denmark": "dnk",
  "finland": "fin",
  "austria": "aut",
  "switzerland": "che",
  "belgium": "bel",
  "lithuania": "ltu",
  "latvia": "lva",
  "estonia": "est",
};

function canonicalCountry(part: string): string {
  const normalized = normalizeForMatch(part);
  return COUNTRY_ALIASES[normalized] ?? normalized;
}

/**
 * Lever renders its own canonical location strings - "Vancouver, BC, CAN" -
 * while a profile records the same place as "Vancouver, British Columbia,
 * Canada". Byte equality therefore rejects the one correct suggestion in the
 * native list and the required field is left blank. Regions are compared by
 * acronym or prefix so "BC" and "British Columbia" agree, which is a
 * difference of notation rather than of place.
 */
function sameRegion(actual: string, approved: string): boolean {
  const left = normalizeForMatch(actual);
  const right = normalizeForMatch(approved);
  if (!left || !right) return !left && !right;
  if (left === right) return true;
  const acronym = (value: string) => value.split(" ").filter(Boolean).map((word) => word[0]).join("");
  if (acronym(left) === right || acronym(right) === left) return true;
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  return shorter.length >= 2 && longer.startsWith(shorter);
}

function splitLocation(value: string): { city: string; region: string; country: string } {
  const parts = value.split(",").map((part) => part.trim()).filter(Boolean);
  const city = normalizeForMatch(parts[0] ?? "");
  if (parts.length <= 1) return { city, region: "", country: "" };
  const country = canonicalCountry(parts[parts.length - 1] ?? "");
  return { city, region: parts.slice(1, -1).join(" "), country };
}

/**
 * Both sides must name the same city and the same country, so "Vancouver, WA,
 * USA" is still rejected for an approved "Vancouver, British Columbia,
 * Canada". A region is only compared when both strings state one.
 */
export function sameLocation(actual: string, approved: string): boolean {
  if (normalizeForMatch(actual) === normalizeForMatch(approved)) return true;
  const left = splitLocation(actual);
  const right = splitLocation(approved);
  if (!left.city || left.city !== right.city) return false;
  if (!left.country || !right.country || left.country !== right.country) return false;
  if (!left.region || !right.region) return true;
  return sameRegion(left.region, right.region);
}

/**
 * Whether a geocoded suggestion is the approved city itself. Greenhouse's
 * "Location (City)" picker lists places that CONTAIN the typed name: "Madrid,
 * Madrid, Spain" offered "Las Rozas de Madrid" and "Humanes de Madrid", and
 * option matching took a different town by containment. The city must be the
 * same and so must the country where both state one; regions are left to
 * option matching, since a geocoder writes them as "Community of Madrid" or
 * "Comunidad de Madrid" as often as "Madrid".
 */
export function sameCity(option: string, approved: string): boolean {
  const left = splitLocation(option);
  const right = splitLocation(approved);
  if (!left.city || left.city !== right.city) return false;
  return !left.country || !right.country || left.country === right.country;
}
