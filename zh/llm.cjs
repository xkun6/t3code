// Minimal LLM client for the overlay scripts: Anthropic Messages or OpenAI Responses.
// Env: DEEPSEEK_API_KEY (required), DEEPSEEK_PROTOCOL (anthropic | responses, default anthropic),
//      DEEPSEEK_BASE_URL, DEEPSEEK_MODEL (default deepseek-chat).
"use strict";

const ATTEMPTS = 3;
const MAX_TOKENS = 8192;

const protocol = process.env.DEEPSEEK_PROTOCOL?.trim() || "anthropic";
const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
const model = process.env.DEEPSEEK_MODEL?.trim() || "deepseek-chat";
const DEFAULT_BASE_URL = {
  anthropic: "https://api.deepseek.com/anthropic",
  responses: "https://api.openai.com/v1",
};
if (!(protocol in DEFAULT_BASE_URL)) throw new Error(`DEEPSEEK_PROTOCOL must be anthropic or responses, got ${protocol}.`);
const baseUrl = (process.env.DEEPSEEK_BASE_URL?.trim() || DEFAULT_BASE_URL[protocol]).replace(/\/+$/, "");

function anthropicRequest({ system, user, temperature }) {
  return {
    url: `${baseUrl}/v1/messages`,
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: { model, max_tokens: MAX_TOKENS, temperature, system, messages: [{ role: "user", content: user }] },
    text: (body) =>
      body.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join(""),
  };
}

function responsesRequest({ system, user }) {
  return {
    url: `${baseUrl}/responses`,
    headers: { Authorization: `Bearer ${apiKey}` },
    // No temperature: reasoning models reject it.
    body: { model, instructions: system, input: user, max_output_tokens: MAX_TOKENS, text: { format: { type: "json_object" } } },
    text: (body) =>
      body.output
        .filter((item) => item.type === "message")
        .flatMap((item) => item.content)
        .filter((part) => part.type === "output_text")
        .map((part) => part.text)
        .join(""),
  };
}

/** The JSON object in a model reply, tolerating code fences or prose around it. */
function parseJsonObject(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error(`reply has no JSON object: ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(start, end + 1));
}

/** Sends one system + user prompt and returns the JSON object the model replied with. */
async function completeJson({ system, user, temperature = 0 }) {
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY is not set.");
  const request = (protocol === "anthropic" ? anthropicRequest : responsesRequest)({ system, user, temperature });
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(request.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...request.headers },
        body: JSON.stringify(request.body),
        signal: AbortSignal.timeout(300_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
      return parseJsonObject(request.text(await response.json()));
    } catch (error) {
      if (attempt >= ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
}

module.exports = { completeJson, protocol, model };
