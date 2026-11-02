import { spawnSync } from "node:child_process";
import { randomInt } from "node:crypto";
import { AppError } from "../util/errors.js";

/**
 * Credentials for boards that require an account before showing a form.
 *
 * Workday makes every applicant register on each employer's tenant, so a
 * password is unavoidable there. It never goes in profile.json, campaign.json
 * or any artifact: config files are committed, backed up and pasted into chat,
 * and a password in one of those is a password that leaks. Nothing here is
 * logged or returned to the caller.
 *
 * AUTOAPPLY_ATS_PASSWORD wins when set. Otherwise, on macOS, the password lives
 * in the login Keychain, and the first board that needs one creates it: a
 * person should not have to invent, type and store a password for accounts
 * nobody signs into by hand. The Workday tenants all get the same one, so it
 * signs back in to an account made on an earlier run.
 */

export type AtsCredentials = { email: string; password: string };

const EMAIL_VAR = "AUTOAPPLY_ATS_EMAIL";
const PASSWORD_VAR = "AUTOAPPLY_ATS_PASSWORD";
/** "off" keeps the server away from the Keychain, for CI and for people who keep it in the environment only. */
const KEYCHAIN_VAR = "AUTOAPPLY_ATS_KEYCHAIN";

export const KEYCHAIN_SERVICE = "autoapply-mcp";
export const KEYCHAIN_ACCOUNT = "ats-password";

/** Runs `security` with these arguments. Injected in tests so the real Keychain is never touched. */
export type KeychainRunner = (args: readonly string[]) => { status: number | null; stdout: string };

const realRunner: KeychainRunner = (args) => {
  const result = spawnSync("security", [...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return { status: result.status, stdout: result.stdout ?? "" };
};

let injected: KeychainRunner | null = null;
/** The password found or created this process, so it can be redacted as well as reused. */
let resolved: string | null = null;

/** Replaces the Keychain with a fake; null restores the real one. */
export function setKeychainRunner(runner: KeychainRunner | null): void {
  injected = runner;
  resolved = null;
}

function keychain(): KeychainRunner | null {
  if (injected) return injected;
  if (process.platform !== "darwin" || process.env[KEYCHAIN_VAR] === "off") return null;
  return realRunner;
}

const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const LOWER = "abcdefghijkmnopqrstuvwxyz";
const DIGITS = "23456789";
/** No quotes, backslashes or spaces: some tenants reject them and they are awkward to retype. */
const SYMBOLS = "!@#$%^&*-_=+?";

/**
 * A 20-character password with every class tenants demand. Each class is
 * guaranteed one character, the rest are drawn from all of them, and the
 * whole is shuffled so the guaranteed ones are not always in front.
 */
export function generateAtsPassword(length = 20): string {
  const all = UPPER + LOWER + DIGITS + SYMBOLS;
  const pick = (set: string) => set[randomInt(set.length)]!;
  const chars = [pick(UPPER), pick(LOWER), pick(DIGITS), pick(SYMBOLS)];
  while (chars.length < length) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join("");
}

function fromKeychain(): string {
  if (resolved) return resolved;
  const run = keychain();
  if (!run) return "";
  const found = run(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"]);
  const stored = found.status === 0 ? found.stdout.replace(/\r?\n$/, "") : "";
  if (stored) {
    resolved = stored;
    return stored;
  }
  const created = generateAtsPassword();
  const added = run(["add-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w", created, "-U"]);
  // A password that could not be stored would register accounts nobody can
  // sign back in to on the next run, so it is not used at all.
  if (added.status !== 0) return "";
  resolved = created;
  return created;
}

/** True when an account-based board can be attempted at all. */
export function hasAtsCredentials(): boolean {
  return Boolean(process.env[PASSWORD_VAR]) || keychain() !== null;
}

/**
 * Returns the account credentials, falling back to the profile's own email so
 * only the password has to be supplied.
 */
export function getAtsCredentials(profileEmail: string): AtsCredentials {
  const password = process.env[PASSWORD_VAR] || fromKeychain();
  if (!password) {
    throw new AppError(
      "credentials_missing",
      `this board requires an account. Set ${PASSWORD_VAR} in the server environment (never in profile.json), or run the server on macOS where it keeps one in the login Keychain, and optionally ${EMAIL_VAR} to use an address other than the profile's.`,
    );
  }
  const email = process.env[EMAIL_VAR] || profileEmail;
  if (!email) {
    throw new AppError("credentials_missing", `no account email available: set ${EMAIL_VAR} or personal.email in profile.json`);
  }
  return { email, password };
}

/**
 * The account password lengthened to a tenant's stated minimum. Red Hat's
 * Workday tenant demands 14 characters, so a shorter stored password could
 * never register there. Repeating it keeps every character class the tenant
 * already accepted, is the same on every run - so the account can be signed
 * into again - and is still removed whole by redactSecrets.
 */
export function lengthenedPassword(password: string, minimum: number): string {
  if (password.length === 0 || password.length >= minimum) return password;
  return password.repeat(Math.ceil(minimum / password.length));
}

/**
 * Removes the password from text that is about to be logged or surfaced.
 *
 * A failing page often echoes what was typed into it, and an error message is
 * the most likely place for a secret to escape into a transcript.
 */
export function redactSecrets(text: string): string {
  let redacted = text;
  for (const password of [process.env[PASSWORD_VAR], resolved]) {
    if (!password || password.length < 4) continue;
    redacted = redacted.split(password).join("[redacted]");
  }
  return redacted;
}
