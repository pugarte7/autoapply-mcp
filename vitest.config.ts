import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Tests must never read or write the real login Keychain. Ones that cover
    // the Keychain fallback inject a fake runner instead.
    env: { AUTOAPPLY_ATS_KEYCHAIN: "off" },
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/index.ts",
        "src/cli/**",
        // Requires a live Playwright browser; exercised manually, not in CI.
        "src/submission/browser.ts",
      ],
      thresholds: {
        statements: 80,
        lines: 80,
        functions: 80,
      },
    },
  },
});
