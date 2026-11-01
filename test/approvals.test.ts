import { describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { askPerson } from "../src/submission/approvals.js";

function serverWith(capabilities: object | undefined, answer?: object): McpServer {
  return {
    server: { getClientCapabilities: () => capabilities, elicitInput: async () => answer },
  } as unknown as McpServer;
}

describe("askPerson", () => {
  it("is the person's yes, through the client's dialog", async () => {
    expect(await askPerson(serverWith({ elicitation: {} }, { action: "accept", content: { approve: true } }), "Send?", "x")).toBe(true);
  });

  it("is no when the person says no, declines or closes the dialog", async () => {
    for (const answer of [
      { action: "accept", content: { approve: false } },
      { action: "decline" },
      { action: "cancel" },
    ]) {
      expect(await askPerson(serverWith({ elicitation: {} }, answer), "Send?", "x")).toBe(false);
    }
  });

  it("refuses without a dialog and hands the person their own command", async () => {
    await expect(askPerson(serverWith(undefined), "Send?", "app_1 abc123")).rejects.toThrow(
      /person_approval_needed|cli\/approve\.js app_1 abc123/,
    );
  });
});
