import { randomUUID } from "node:crypto";

export const MAX_STEPS = 4;
export const WALL_CLOCK_TIMEOUT = 30_000;

function awaitWithAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(Object.assign(new Error("Alfie turn deadline reached."), { name: "AbortError" }));
  let listener;
  const aborted = new Promise((_, reject) => {
    listener = () => reject(Object.assign(new Error("Alfie turn deadline reached."), { name: "AbortError" }));
    signal.addEventListener("abort", listener, { once: true });
  });
  return Promise.race([promise, aborted]).finally(() => signal.removeEventListener("abort", listener));
}

function hasExactKeys(value, expected) {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function parseModelAction(content) {
  const raw = String(content || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected one JSON object.");
    return value;
  } catch (error) {
    throw Object.assign(new Error(`Malformed JSON from model: ${error.message}. Return exactly one valid JSON object.`), { code: "MODEL_JSON_INVALID" });
  }
}

export class AgentLoop {
  constructor({ providerRegistry, providerConfig, toolRegistry, dispatcher, contextAssembler, memoryStore = null, now = () => Date.now(), maxSteps = MAX_STEPS, wallClockTimeout = WALL_CLOCK_TIMEOUT } = {}) {
    this.providerRegistry = providerRegistry;
    this.providerConfig = providerConfig;
    this.toolRegistry = toolRegistry;
    this.dispatcher = dispatcher;
    this.contextAssembler = contextAssembler;
    this.memoryStore = memoryStore;
    this.now = now;
    this.maxSteps = Math.min(MAX_STEPS, Math.max(1, maxSteps));
    this.wallClockTimeout = Math.min(WALL_CLOCK_TIMEOUT, Math.max(1000, wallClockTimeout));
  }

  async run({ userId, messages, dashboardState = {}, mode = "auto", turnId = randomUUID(), signal: parentSignal }) {
    const started = this.now();
    const controller = new AbortController();
    const abortFromParent = () => controller.abort(parentSignal?.reason || new Error("Client disconnected."));
    if (parentSignal?.aborted) abortFromParent();
    else parentSignal?.addEventListener("abort", abortFromParent, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("Alfie turn exceeded the 30-second execution budget.")), this.wallClockTimeout);
    const history = messages.slice(-16).map((message) => ({ role: message.role, content: String(message.content || "").slice(0, 12000) }));
    const userText = [...history].reverse().find((message) => message.role === "user")?.content || "";
    let memories = [];
    if (this.memoryStore?.search) {
      try {
        memories = await awaitWithAbort(this.memoryStore.search(userId, userText, { limit: 6 }), controller.signal);
      } catch (error) {
        if (controller.signal.aborted) throw error;
        // Memory retrieval is useful context, not a dependency that should take chat offline.
        memories = [];
      }
    }
    let previousCall = null;
    let steps = 0;
    try {
      while (steps < this.maxSteps) {
        if (controller.signal.aborted || this.now() - started >= this.wallClockTimeout) {
          this.dispatcher.resetTurn(turnId);
          return { status: "timeout", message: "I reached the 30-second processing limit. Please try a smaller request.", steps };
        }
        const grantedScopes = await this.dispatcher.permissionStore.list(userId);
        const context = this.contextAssembler.assemble({
          userText, history, dashboardState, memories, registry: this.toolRegistry, grantedScopes
        });
        const selected = await awaitWithAbort(this.providerRegistry.complete(this.providerConfig, context.messages, mode, { signal: controller.signal }), controller.signal);
        steps += 1;
        let action;
        try {
          action = parseModelAction(selected.result.content);
        } catch (error) {
          history.push({ role: "assistant", content: String(selected.result?.content || "").slice(0, 2000) });
          history.push({ role: "user", content: JSON.stringify({ error: error.message }) });
          continue;
        }

        if (action.type === "final" && hasExactKeys(action, ["type", "message"]) && typeof action.message === "string") {
          this.dispatcher.resetTurn(turnId);
          return { status: "completed", message: action.message.slice(0, 12000), steps, model: selected.endpoint.model, provider: selected.endpoint.provider, endpointId: selected.endpoint.id };
        }
        if (action.type !== "tool_call" || !hasExactKeys(action, ["type", "tool", "arguments"]) || typeof action.tool !== "string" || !action.arguments || typeof action.arguments !== "object" || Array.isArray(action.arguments)) {
          history.push({ role: "user", content: JSON.stringify({ error: "Invalid response schema. Expected {type:'final', message:string} or {type:'tool_call', tool:string, arguments:object}." }) });
          continue;
        }

        const callSignature = JSON.stringify([action.tool, action.arguments]);
        if (previousCall === callSignature) {
          this.dispatcher.resetTurn(turnId);
          return { status: "stopped", message: "I stopped because the model repeated the same tool call with identical arguments.", steps };
        }
        previousCall = callSignature;
        let observation;
        try {
          observation = await this.dispatcher.dispatch({
            userId, toolId: action.tool, args: action.arguments, turnId, contextMessages: context.messages, signal: controller.signal
          });
        } catch (error) {
          observation = { status: "tool_error", error: error.message };
          if (error.code === "DUPLICATE_TOOL_CALL") {
            this.dispatcher.resetTurn(turnId);
            return { status: "stopped", message: observation.error, steps };
          }
        }
        if (observation.status === "awaiting_user_approval") {
          this.dispatcher.resetTurn(turnId);
          return { ...observation, message: "This action is ready for your approval.", steps };
        }
        history.push({ role: "assistant", content: JSON.stringify(action).slice(0, 2000) });
        const modelObservation = observation.status === "tool_error" ? { error: observation.error } : { tool_observation: observation };
        history.push({ role: "user", content: JSON.stringify(modelObservation).slice(0, 4000) });
      }
      this.dispatcher.resetTurn(turnId);
      return { status: "step_limit", message: "I reached the four-step limit for this request. Ask me to continue if more work is needed.", steps };
    } catch (error) {
      this.dispatcher.resetTurn(turnId);
      if (controller.signal.aborted) return { status: "timeout", message: "I reached the 30-second processing limit.", steps };
      throw error;
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abortFromParent);
    }
  }
}
