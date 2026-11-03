import { readFileSync } from "node:fs";

/**
 * Read from package.json rather than written out, because a hand-kept copy
 * drifted: the server announced 0.2.0 to clients while npm published 0.1.0.
 * The path resolves the same from src/ under vitest and from dist/ once built,
 * and package.json ships in the npm tarball beside dist/.
 */
export const VERSION: string = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;
