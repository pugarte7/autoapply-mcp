#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";
import { logger } from "./util/logger.js";
import { toErrorMessage } from "./util/errors.js";
import { closeAllGateSessions } from "./submission/sessions.js";

/**
 * stdio entry point. stdout carries the JSON-RPC stream, so all diagnostics go
 * to stderr.
 */
async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  // A browser held at a verification gate keeps the process alive, so leaving
  // with the client, or on a signal, closes it rather than orphaning it.
  server.server.onclose = () => void closeAllGateSessions();
  process.stdin.once("end", () => void closeAllGateSessions());
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => void closeAllGateSessions().finally(() => process.exit(0)));
  }
  await server.connect(transport);
  logger.info("server started", { name: SERVER_NAME, version: SERVER_VERSION });
}

process.on("unhandledRejection", (reason) => {
  logger.error("unhandled rejection", { reason: toErrorMessage(reason) });
});

main().catch((error) => {
  logger.error("fatal startup error", { error: toErrorMessage(error) });
  process.exitCode = 1;
});
