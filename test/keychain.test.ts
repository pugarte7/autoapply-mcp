import { afterEach, describe, expect, it } from "vitest";
import {
  KEYCHAIN_ACCOUNT,
  KEYCHAIN_SERVICE,
  generateAtsPassword,
  getAtsCredentials,
  hasAtsCredentials,
  redactSecrets,
  setKeychainRunner,
  type KeychainRunner,
} from "../src/submission/credentials.js";

/**
 * The ATS password falls back to the macOS login Keychain, and is created
 * there the first time. A fake `security` stands in so the real Keychain is
 * never read or written.
 */

function fakeKeychain(initial?: string) {
  const store = new Map<string, string>();
  if (initial) store.set(`${KEYCHAIN_SERVICE}/${KEYCHAIN_ACCOUNT}`, initial);
  const calls: string[][] = [];
  const run: KeychainRunner = (args) => {
    calls.push([...args]);
    const service = args[args.indexOf("-s") + 1];
    const account = args[args.indexOf("-a") + 1];
    const id = `${service}/${account}`;
    if (args[0] === "find-generic-password") {
      const found = store.get(id);
      return found ? { status: 0, stdout: `${found}\n` } : { status: 44, stdout: "" };
    }
    if (args[0] === "add-generic-password") {
      store.set(id, args[args.indexOf("-w") + 1]!);
      return { status: 0, stdout: "" };
    }
    return { status: 1, stdout: "" };
  };
  return { run, store, calls };
}

afterEach(() => {
  setKeychainRunner(null);
  delete process.env.AUTOAPPLY_ATS_PASSWORD;
});

describe("ATS password from the Keychain", () => {
  it("uses the stored password", () => {
    const keychain = fakeKeychain("Stored-Password-1234!");
    setKeychainRunner(keychain.run);

    expect(getAtsCredentials("casey@example.com").password).toBe("Stored-Password-1234!");
    expect(keychain.calls[0]).toEqual(["find-generic-password", "-s", "autoapply-mcp", "-a", "ats-password", "-w"]);
  });

  it("creates and stores a strong password when there is none, then reuses it", () => {
    const keychain = fakeKeychain();
    setKeychainRunner(keychain.run);

    const first = getAtsCredentials("casey@example.com").password;
    expect(first).toHaveLength(20);
    expect(keychain.store.get("autoapply-mcp/ats-password")).toBe(first);
    expect(keychain.calls.some((call) => call[0] === "add-generic-password")).toBe(true);

    // A new process reads it back rather than making another.
    setKeychainRunner(keychain.run);
    expect(getAtsCredentials("casey@example.com").password).toBe(first);
  });

  it("lets the environment variable override the Keychain", () => {
    const keychain = fakeKeychain("Stored-Password-1234!");
    setKeychainRunner(keychain.run);
    process.env.AUTOAPPLY_ATS_PASSWORD = "from-the-environment";

    expect(getAtsCredentials("casey@example.com").password).toBe("from-the-environment");
    expect(keychain.calls).toHaveLength(0);
  });

  it("does not use a password it could not store, since nobody could sign back in", () => {
    setKeychainRunner(() => ({ status: 1, stdout: "" }));

    expect(() => getAtsCredentials("casey@example.com")).toThrow(/credentials_missing|requires an account/);
  });

  it("redacts the Keychain password too", () => {
    setKeychainRunner(fakeKeychain("Stored-Password-1234!").run);
    getAtsCredentials("casey@example.com");

    expect(redactSecrets("typed Stored-Password-1234! into the form")).toBe("typed [redacted] into the form");
  });

  it("reports an account board as attemptable once a Keychain is available", () => {
    expect(hasAtsCredentials()).toBe(false);
    setKeychainRunner(fakeKeychain().run);
    expect(hasAtsCredentials()).toBe(true);
  });

  it("generates passwords with every character class", () => {
    for (let i = 0; i < 50; i += 1) {
      const password = generateAtsPassword();
      expect(password).toHaveLength(20);
      expect(password).toMatch(/[A-Z]/);
      expect(password).toMatch(/[a-z]/);
      expect(password).toMatch(/[0-9]/);
      expect(password).toMatch(/[^A-Za-z0-9]/);
      expect(password).not.toMatch(/[\s"'\\]/);
    }
  });
});
