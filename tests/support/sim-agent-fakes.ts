import Anthropic from "@anthropic-ai/sdk";

// Story 9.3: a scripted fake model for the persona agents. Each request's body and headers are recorded,
// and `script(body, n)` decides the reply: a message (content, stop_reason, usage) or an HTTP status.
// No network, no API key, no model call.

export type FakeRequest = { body: Record<string, any>; headers: Headers };
export type FakeReply =
  | { content: unknown[]; stop_reason: string; usage?: Record<string, number>; stop_details?: unknown; model?: string }
  | { status: number; error?: string };

export const text = (t: string) => ({ type: "text", text: t });
export const toolUse = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });
export const USAGE = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 500, cache_creation_input_tokens: 100 };

export function fakeModel(script: (body: Record<string, any>, n: number) => FakeReply) {
  const requests: FakeRequest[] = [];
  const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    requests.push({ body, headers: new Headers(init?.headers) });
    const reply = script(body, requests.length);
    if ("status" in reply) {
      return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: reply.error ?? "Internal server error" } }), {
        status: reply.status, headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({
      id: `msg_${requests.length}`, type: "message", role: "assistant", model: reply.model ?? body.model,
      content: reply.content, stop_reason: reply.stop_reason, stop_sequence: null, stop_details: reply.stop_details ?? null,
      usage: reply.usage ?? USAGE,
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const client = new Anthropic({ apiKey: "test", fetch, maxRetries: 0 });
  return { client, requests };
}

/** A model that ends every turn at once with the given notes. */
export const quietModel = (notes = "nothing new") => fakeModel(() => ({ content: [text(`Done.\nNOTES: ${notes}`)], stop_reason: "end_turn" }));
