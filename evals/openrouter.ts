import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CallTool, ToolCall, Transcript } from "./scenarios.ts";

/**
 * "native" sends the server's tools through the API's `tools` parameter.
 * "hermes" describes them in the system prompt and reads <tool_call> blocks
 * out of the reply, the format Hermes models are trained on: OpenRouter does
 * not pass `tools` to them.
 */
export type Model = { alias: string; id: string; protocol: "native" | "hermes" };

export const MODELS: Model[] = [
  { alias: "grok", id: "x-ai/grok-4.7", protocol: "native" },
  { alias: "muse", id: "meta/muse-spark-1.3", protocol: "native" },
  { alias: "muse-wonder", id: "meta/muse-wonder", protocol: "native" },
  { alias: "hermes", id: "nousresearch/hermes-4-405b", protocol: "hermes" },
];

export type ToolSpec = { name: string; description?: string; inputSchema: unknown };

type NativeCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type Message = { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_calls?: NativeCall[]; tool_call_id?: string };
type Requested = { id: string; name: string; rawArgs: string };

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const MAX_ROUNDS = 16;
/** Tool results are cut here before going back to the model; the transcript keeps them whole. */
const MAX_RESULT_CHARS = 12_000;
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

/** The account has no credit left; every later request would fail the same way. */
export class OutOfCredits extends Error {}

export function apiKey(): string {
  const fromEnv = process.env.OPENROUTER_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    return readFileSync(join(homedir(), ".config", "openrouter", "api_key"), "utf8").trim();
  } catch {
    throw new Error("no OpenRouter key: set OPENROUTER_API_KEY or write it to ~/.config/openrouter/api_key");
  }
}

async function complete(model: Model, messages: Message[], tools?: unknown[]): Promise<{ message: Message; cost: number }> {
  const body = JSON.stringify({ model: model.id, messages, max_tokens: 4000, ...(tools ? { tools, tool_choice: "auto" } : {}) });
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey()}`, "content-type": "application/json" },
      body,
    });
    if (RETRYABLE.has(response.status) && attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 2000 * 2 ** attempt));
      continue;
    }
    const text = await response.text();
    if (response.status === 402) throw new OutOfCredits(`${model.id}: ${text.slice(0, 300)}`);
    if (!response.ok) throw new Error(`${model.id}: HTTP ${response.status} ${text.slice(0, 300)}`);
    const json = JSON.parse(text) as { choices?: Array<{ message: Message }>; usage?: { cost?: number }; error?: { message: string } };
    const message = json.choices?.[0]?.message;
    if (json.error || !message) throw new Error(`${model.id}: ${json.error?.message ?? "no message in reply"}`);
    return { message, cost: json.usage?.cost ?? 0 };
  }
}

function hermesSystemPrompt(system: string, tools: readonly ToolSpec[]): string {
  const signatures = tools.map((tool) => ({ name: tool.name, description: tool.description ?? "", parameters: tool.inputSchema }));
  return `${system}

You are a function calling AI model. You are provided with function signatures within <tools></tools> XML tags. You may call one or more functions to assist with the user query. Don't make assumptions about what values to plug into functions. Here are the available tools: <tools>${JSON.stringify(signatures)}</tools>
For each function call return a json object with function name and arguments within <tool_call></tool_call> XML tags as follows:
<tool_call>
{"name": <function-name>, "arguments": <args-dict>}
</tool_call>`;
}

function hermesCalls(content: string): Requested[] {
  return [...content.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)].map((match, index) => {
    const raw = match[1] ?? "";
    try {
      const parsed = JSON.parse(raw) as { name?: unknown; arguments?: unknown };
      return { id: String(index), name: String(parsed.name ?? ""), rawArgs: JSON.stringify(parsed.arguments ?? {}) };
    } catch {
      return { id: String(index), name: "", rawArgs: raw };
    }
  });
}

/**
 * Runs one conversation: the user's prompt, then tool rounds until the model
 * answers or the round limit. Tool calls land in `calls` as they happen, so a
 * conversation cut short by an error still shows what the model did.
 */
export async function converse(
  model: Model,
  system: string,
  prompt: string,
  tools: readonly ToolSpec[],
  call: CallTool,
  calls: ToolCall[],
): Promise<Transcript & { cost: number }> {
  const native = model.protocol === "native";
  const toolDefs = tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description ?? "", parameters: tool.inputSchema },
  }));
  const messages: Message[] = [
    { role: "system", content: native ? system : hermesSystemPrompt(system, tools) },
    { role: "user", content: prompt },
  ];
  let cost = 0;

  const execute = async (requested: Requested): Promise<string> => {
    let args: Record<string, unknown>;
    try {
      args = requested.rawArgs.trim() ? (JSON.parse(requested.rawArgs) as Record<string, unknown>) : {};
    } catch {
      calls.push({ name: requested.name, args: {}, isError: true, result: "unparseable arguments" });
      return `[invalid_arguments] could not parse ${requested.rawArgs.slice(0, 200)}`;
    }
    const result = await call(requested.name, args);
    calls.push({ name: requested.name, args, isError: result.isError, result: result.text });
    return result.text.slice(0, MAX_RESULT_CHARS);
  };

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const reply = await complete(model, messages, native ? toolDefs : undefined);
    cost += reply.cost;
    const content = reply.message.content ?? "";
    const requested: Requested[] = native
      ? (reply.message.tool_calls ?? []).map((nc) => ({ id: nc.id, name: nc.function.name, rawArgs: nc.function.arguments }))
      : hermesCalls(content);
    if (requested.length === 0) return { calls, finalText: content, stoppedBy: "answer", cost };

    if (native) {
      messages.push({ role: "assistant", content: reply.message.content, tool_calls: reply.message.tool_calls });
      for (const each of requested) messages.push({ role: "tool", tool_call_id: each.id, content: await execute(each) });
    } else {
      messages.push({ role: "assistant", content });
      const responses: string[] = [];
      for (const each of requested) {
        responses.push(`<tool_response>\n${JSON.stringify({ name: each.name, content: await execute(each) })}\n</tool_response>`);
      }
      messages.push({ role: "user", content: responses.join("\n") });
    }
  }
  return { calls, finalText: "", stoppedBy: "turn_limit", cost };
}
