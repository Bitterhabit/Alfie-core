import { GoogleGenAI } from "@google/genai";

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

function safeJsonFinal(text) {
  const trimmed = String(text || "").trim();
  const unwrapped = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const parsed = JSON.parse(unwrapped);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && (parsed.type === "final" || parsed.type === "tool_call")) {
      return JSON.stringify(parsed);
    }
  } catch {}
  return JSON.stringify({ type: "final", message: trimmed });
}

function splitSystemAndConversation(messages = []) {
  const systemParts = [];
  const conversation = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const content = String(message?.content || "").trim();
    if (!content) continue;
    if (message.role === "system") {
      systemParts.push(content);
    } else {
      conversation.push({
        role: message.role === "assistant" ? "assistant" : "user",
        content
      });
    }
  }
  return {
    systemInstruction: systemParts.join("\n\n"),
    conversation
  };
}

function validateOpenAiBaseUrl(rawUrl) {
  const candidate = String(rawUrl || DEFAULT_OPENAI_BASE_URL).trim() || DEFAULT_OPENAI_BASE_URL;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw Object.assign(new Error("ALFIE_OPENAI_BASE_URL is not a valid HTTPS URL."), { status: 500 });
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw Object.assign(new Error("ALFIE_OPENAI_BASE_URL must be an HTTPS URL without embedded credentials."), { status: 500 });
  }
  return parsed.toString().replace(/\/$/, "");
}

export class CloudAgentAdapters {
  constructor({
    env = process.env,
    fetchImpl = globalThis.fetch,
    geminiClientFactory = null
  } = {}) {
    this.env = env;
    this.fetchImpl = fetchImpl;
    this.geminiClientFactory = geminiClientFactory;
  }

  async complete({ provider, model, messages, hasTools = false, signal } = {}) {
    if (provider === "gemini") {
      return this.completeGemini({ model, messages, hasTools, signal });
    }
    if (provider === "openai") {
      return this.completeOpenAi({ model, messages, hasTools, signal });
    }
    throw Object.assign(new Error(`Unsupported cloud agent provider "${provider}".`), { status: 400 });
  }

  async completeGemini({ model = "gemini-4-hydrogen", messages = [], hasTools = false, signal } = {}) {
    const apiKey = String(this.env?.GEMINI_API_KEY || "").trim();
    if (!apiKey) {
      throw Object.assign(
        new Error("Gemini API key is not configured on the server. Add GEMINI_API_KEY in Settings > Secrets or your server environment."),
        { status: 503, code: "CLOUD_SECRET_MISSING" }
      );
    }

    const { systemInstruction, conversation } = splitSystemAndConversation(messages);
    const codingInstruction = hasTools
      ? systemInstruction
      : `${systemInstruction}\n\nNote: No external tools are attached for this coding turn. Reply directly in clear, well-structured Markdown.`;

    const contents = conversation.map((msg) => ({
      role: msg.role === "assistant" ? "model" : "user",
      parts: [{ text: msg.content }]
    }));

    const ai = this.geminiClientFactory
      ? this.geminiClientFactory({ apiKey })
      : new GoogleGenAI({
          apiKey,
          httpOptions: {
            headers: { "User-Agent": "aistudio-build" }
          }
        });

    let response;
    try {
      const requestPromise = ai.models.generateContent({
        model,
        contents: contents.length ? contents : [{ role: "user", parts: [{ text: "Hello" }] }],
        config: {
          systemInstruction: codingInstruction
        }
      });
      if (signal) {
        if (signal.aborted) throw Object.assign(new Error("Gemini request was aborted."), { name: "AbortError" });
        let onAbort;
        const abortPromise = new Promise((_, reject) => {
          onAbort = () => reject(Object.assign(new Error("Gemini request was aborted."), { name: "AbortError" }));
          signal.addEventListener("abort", onAbort, { once: true });
        });
        response = await Promise.race([requestPromise, abortPromise]).finally(() => {
          signal.removeEventListener("abort", onAbort);
        });
      } else {
        response = await requestPromise;
      }
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      const status = Number.isInteger(error?.status) ? error.status : 502;
      throw Object.assign(
        new Error(`Gemini API request failed: ${error?.message || "Unknown upstream error."}`),
        { status: status >= 400 && status < 600 ? status : 502, code: "GEMINI_UPSTREAM_ERROR" }
      );
    }

    const text = typeof response?.text === "string" ? response.text.trim() : "";
    if (!text) {
      throw Object.assign(new Error("Gemini API returned an empty response."), { status: 502, code: "GEMINI_EMPTY_RESPONSE" });
    }

    const usageMeta = response?.usageMetadata || {};
    return {
      endpoint: { id: "cloud-gemini", model, provider: "gemini" },
      result: {
        content: safeJsonFinal(text),
        raw: {
          usage: {
            prompt_tokens: usageMeta.promptTokenCount ?? undefined,
            completion_tokens: usageMeta.candidatesTokenCount ?? undefined,
            total_tokens: usageMeta.totalTokenCount ?? undefined
          }
        }
      }
    };
  }

  async completeOpenAi({ model = "gpt-4.1-mini", messages = [], hasTools = false, signal } = {}) {
    const apiKey = String(this.env?.OPENAI_API_KEY || "").trim();
    if (!apiKey) {
      throw Object.assign(
        new Error("ChatGPT (OpenAI) API key is not configured on the server. Add OPENAI_API_KEY in Settings > Secrets or your server environment."),
        { status: 503, code: "CLOUD_SECRET_MISSING" }
      );
    }

    const baseUrl = validateOpenAiBaseUrl(this.env?.ALFIE_OPENAI_BASE_URL);
    const { systemInstruction, conversation } = splitSystemAndConversation(messages);
    const codingInstruction = hasTools
      ? systemInstruction
      : `${systemInstruction}\n\nNote: No external tools are attached for this coding turn. Reply directly in clear, well-structured Markdown.`;

    const payloadMessages = [
      ...(codingInstruction ? [{ role: "system", content: codingInstruction }] : []),
      ...conversation
    ];

    const timeout = AbortSignal.timeout(25000);
    const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;

    let response;
    try {
      response = await this.fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model,
          messages: payloadMessages
        }),
        redirect: "error",
        signal: combinedSignal
      });
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      throw Object.assign(
        new Error(`ChatGPT (OpenAI) network error: ${error?.message || "Could not reach OpenAI API."}`),
        { status: 502, code: "OPENAI_NETWORK_ERROR" }
      );
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const upstreamMessage = data?.error?.message || `OpenAI API returned HTTP ${response.status}.`;
      throw Object.assign(
        new Error(`ChatGPT (OpenAI) API error: ${upstreamMessage}`),
        { status: response.status >= 400 && response.status < 600 ? response.status : 502, code: "OPENAI_UPSTREAM_ERROR" }
      );
    }

    const text = String(data?.choices?.[0]?.message?.content || "").trim();
    if (!text) {
      throw Object.assign(new Error("ChatGPT (OpenAI) API returned an empty response."), { status: 502, code: "OPENAI_EMPTY_RESPONSE" });
    }

    return {
      endpoint: { id: "cloud-openai", model: data?.model || model, provider: "openai" },
      result: {
        content: safeJsonFinal(text),
        raw: {
          usage: data?.usage || {}
        }
      }
    };
  }
}
