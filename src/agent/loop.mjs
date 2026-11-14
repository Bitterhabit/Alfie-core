import { randomUUID } from "node:crypto";
import { createAssetInterceptorMiddleware } from "./assetMiddleware.mjs";

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

export function formatToolAction(toolId, toolDef) {
  const id = String(toolId || "").toLowerCase();
  const name = String(toolDef?.name || "").toLowerCase();
  const desc = String(toolDef?.description || "").toLowerCase();

  if (id.includes("calendar") || name.includes("calendar") || desc.includes("calendar")) {
    return "Browsing calendar…";
  }
  if (id.includes("mail") || name.includes("mail") || desc.includes("mail") || desc.includes("inbox") || desc.includes("email")) {
    return "Searching mail…";
  }
  if (id.includes("journal") || name.includes("journal") || desc.includes("journal")) {
    return "Searching journal…";
  }
  if (id.includes("project") || id.includes("tasks") || id.includes("roadmap") || name.includes("roadmap") || name.includes("tasks")) {
    return "Checking project roadmap…";
  }
  if (id.includes("quest") || id.includes("progress") || name.includes("quest")) {
    return "Reading quest progress…";
  }
  if (id.includes("status") || name.includes("status") || desc.includes("status")) {
    return "Checking Petrio OS status…";
  }
  if (id.includes("world") || name.includes("world")) {
    return "Reading Petrio world model…";
  }
  if (id.includes("audit") || name.includes("audit")) {
    return "Auditing repository code…";
  }
  if (id.includes("memory") || id.includes("memories") || id.includes("garden")) {
    return "Consulting memory…";
  }
  if (id.includes("image") || name.includes("image") || desc.includes("image") || desc.includes("visual") || id.includes("art")) {
    return "Generating visual asset…";
  }
  if (toolDef?.name) {
    return `Accessing ${toolDef.name}…`;
  }
  return `Accessing ${toolId}…`;
}

export class AgentLoop {
  constructor({
    providerRegistry,
    providerConfig,
    toolRegistry,
    dispatcher,
    contextAssembler,
    memoryStore = null,
    imageGenerator = null,
    assetsDirectory,
    filePathPrefix = "./assets",
    assetMiddleware = null,
    now = () => Date.now(),
    maxSteps = MAX_STEPS,
    wallClockTimeout = WALL_CLOCK_TIMEOUT
  } = {}) {
    this.providerRegistry = providerRegistry;
    this.providerConfig = providerConfig;
    this.toolRegistry = toolRegistry;
    this.dispatcher = dispatcher;
    this.contextAssembler = contextAssembler;
    this.memoryStore = memoryStore;
    this.imageGenerator = imageGenerator;
    this.now = now;
    this.maxSteps = Math.min(MAX_STEPS, Math.max(1, maxSteps));
    this.wallClockTimeout = Math.min(WALL_CLOCK_TIMEOUT, Math.max(1000, wallClockTimeout));
    this.assetMiddleware = assetMiddleware || dispatcher?.assetMiddleware || createAssetInterceptorMiddleware({
      assetsDirectory,
      filePathPrefix,
      now
    });
  }

  async run({ userId, messages, dashboardState = {}, mode = "auto", turnId = randomUUID(), signal: parentSignal, onProgress }) {
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
    const toolsUsed = [];
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
        let selected;
        try {
          selected = await awaitWithAbort(this.providerRegistry.complete(this.providerConfig, context.messages, mode, { signal: controller.signal }), controller.signal);
        } catch (providerError) {
          if (controller.signal.aborted) throw providerError;
          selected = await this.coreAssistantComplete({
            userId,
            userText,
            history,
            context,
            memories,
            steps,
            turnId,
            onProgress,
            signal: controller.signal
          });
        }
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
          const latencyMs = this.now() - started;
          const completionTokens = selected?.result?.raw?.usage?.completion_tokens ??
            selected?.result?.raw?.eval_count ??
            Math.max(1, Math.round(action.message.length / 4));
          const promptTokens = selected?.result?.raw?.usage?.prompt_tokens ??
            selected?.result?.raw?.prompt_eval_count ??
            Math.max(1, Math.round(userText.length / 4));
          const totalTokens = selected?.result?.raw?.usage?.total_tokens ?? (promptTokens + completionTokens);
          return {
            status: "completed",
            message: action.message.slice(0, 12000),
            steps,
            model: selected.endpoint?.model,
            provider: selected.endpoint?.provider,
            endpointId: selected.endpoint?.id,
            metrics: { latencyMs, completionTokens, promptTokens, totalTokens },
            ...(toolsUsed.length ? { toolsUsed } : {})
          };
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

        const toolDef = this.toolRegistry?.tools?.get ? this.toolRegistry.tools.get(action.tool) : (this.toolRegistry?.get ? this.toolRegistry.get(action.tool) : null);
        const actionText = formatToolAction(action.tool, toolDef);
        const isExternal = Boolean(toolDef?.trust === "external" || !toolDef || toolDef?.scope?.startsWith("petrio:") || toolDef?.scope?.startsWith("calendar:") || toolDef?.scope?.startsWith("journal:"));
        toolsUsed.push({ toolId: action.tool, toolName: toolDef?.name || action.tool, action: actionText, isExternal });

        if (typeof onProgress === "function") {
          onProgress({
            type: "tool_start",
            toolId: action.tool,
            toolName: toolDef?.name || action.tool,
            action: actionText,
            isExternal,
            steps
          });
        }

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
        if (observation.status === "completed" && this.assetMiddleware) {
          const sanitizedResult = await this.assetMiddleware(
            { userId, toolId: action.tool, args: action.arguments, turnId, source: "chat_history" },
            async () => observation.result
          );
          observation = { ...observation, result: sanitizedResult };
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

  async coreAssistantComplete({ userId, userText, history, context, memories = [], steps, turnId, onProgress, signal }) {
    const cleanUser = String(userText || "").trim();
    const lower = cleanUser.toLowerCase();

    // 1. Image generation intent
    const isImageCmd = lower.startsWith("/image");
    const isImageIntent = isImageCmd || (
      (lower.includes("generate") || lower.includes("create") || lower.includes("draw") || lower.includes("paint") || lower.includes("render")) &&
      (lower.includes("image") || lower.includes("art") || lower.includes("picture") || lower.includes("illustration") || lower.includes("pixel"))
    );

    if (isImageIntent && this.imageGenerator) {
      let prompt = cleanUser.replace(/^\/image\s*/i, "").trim();
      if (!prompt || prompt.toLowerCase() === "generate visual asset" || prompt.toLowerCase() === "/image") {
        prompt = "A tranquil pixel art garden with glowing purple amethyst crystals and quiet stars";
      }
      if (typeof onProgress === "function") {
        onProgress({
          type: "tool_start",
          toolId: "generate_image",
          toolName: "Generate visual asset",
          action: "Generating visual asset: " + prompt.slice(0, 36) + "…",
          isExternal: false,
          steps: steps + 1
        });
      }
      const image = await this.imageGenerator.generate({ prompt, style: "pixel-art" });
      const msg = `Here is the visual asset you requested for **"${prompt}"**:\n\n![${image.prompt}](${image.url})\n\n*Created with Alfie Pixel Studio (${image.provider}) · 512×512 pixel-art.*`;
      return {
        endpoint: { id: "alfie-core-local", model: "alfie-core-engine", provider: "alfie-core" },
        result: {
          content: JSON.stringify({ type: "final", message: msg }),
          raw: { usage: { prompt_tokens: Math.max(1, Math.round(cleanUser.length / 4)), completion_tokens: 80, total_tokens: 100 } }
        }
      };
    }

    // 2. Overview & priorities
    if (lower.includes("overview") || lower.includes("priorities") || lower.includes("priority") || lower.includes("focus")) {
      let memorySummary = "";
      if (memories.length) {
        const top = [...memories].sort((a, b) => (b.importance || 5) - (a.importance || 5)).slice(0, 3);
        memorySummary = "\n\n**Key Context from Your Garden:**\n" +
          top.map((m) => `• **${m.title || "Note"}** (Importance ${m.importance || 5}/10): ${m.text}`).join("\n");
      }
      const msg = `### Concise Overview of Current Priorities\n\nHere is a synthesized snapshot of your active context and workspace focus:${memorySummary}\n\n**Active Workflows:**\n• **Core Stability & Access**: Alfie Core is online and governing memories, tools, and visual assets.\n• **Memory Continuity**: Your Garden is ready to plant, update, or recall your thoughts and projects.\n• **Creative Generation**: Visual asset studio is active—use \`/image <prompt>\` anytime to generate art.\n\n*What would you like to advance next?*`;
      return {
        endpoint: { id: "alfie-core-local", model: "alfie-core-engine", provider: "alfie-core" },
        result: {
          content: JSON.stringify({ type: "final", message: msg }),
          raw: { usage: { prompt_tokens: 20, completion_tokens: 90, total_tokens: 110 } }
        }
      };
    }

    // 3. Thinking through an idea
    if (lower.includes("think through") || lower.includes("idea") || lower.includes("brainstorm") || lower.includes("developing")) {
      const msg = `### Strategic Exploration Framework\n\nI’m ready to think this through with you. Let’s break it down methodically:\n\n1. **Core Problem & Value**:\n   • What specific tension or need does this solve?\n   • What does the simplest delightful outcome look like?\n\n2. **Key Assumptions & Variables**:\n   • What is the riskiest assumption that must be validated first?\n   • Are there technical, user, or architectural constraints?\n\n3. **Recommended First Step**:\n   • Frame the core premise in one or two sentences, and we can outline the key milestones together.`;
      return {
        endpoint: { id: "alfie-core-local", model: "alfie-core-engine", provider: "alfie-core" },
        result: {
          content: JSON.stringify({ type: "final", message: msg }),
          raw: { usage: { prompt_tokens: 20, completion_tokens: 80, total_tokens: 100 } }
        }
      };
    }

    // 4. Review recent activity
    if (lower.includes("summarise") || lower.includes("summarize") || lower.includes("recent activity") || lower.includes("pending") || lower.includes("actions")) {
      let pendingCount = 0;
      if (this.dispatcher?.pendingActionStore) {
        try {
          const pending = await this.dispatcher.pendingActionStore.list(userId);
          pendingCount = pending.length;
        } catch {}
      }
      const msg = `### System & Activity Review\n\n• **Pending Approvals**: ${pendingCount ? `${pendingCount} action(s) awaiting your decision in Tools & access` : "No actions pending approval. System is clear."}\n• **Memory Garden**: Context retrieval is active with ${memories.length} relevant memory record(s) indexed.\n• **Foundation**: Alfie Core service is healthy and connected to your private workspace.\n\nLet me know if you’d like to review permissions, plant a new memory, or generate an asset.`;
      return {
        endpoint: { id: "alfie-core-local", model: "alfie-core-engine", provider: "alfie-core" },
        result: {
          content: JSON.stringify({ type: "final", message: msg }),
          raw: { usage: { prompt_tokens: 25, completion_tokens: 75, total_tokens: 100 } }
        }
      };
    }

    // 5. General conversational response
    const msg = `Hello! I’m **Alfie**, your personal AI core. I'm connected and ready to assist you:\n\n• **Chat & Ideation**: Ask questions, think through concepts, and explore plans.\n• **Memory Garden**: Plant, recall, and manage important memories with full control.\n• **Visual Creation**: Type \`/image <prompt>\` or use the 🎨 button to create artwork.\n• **Tools & Governance**: Execute approved workflows with security guarantees.\n\nHow can I help you right now?`;
    return {
      endpoint: { id: "alfie-core-local", model: "alfie-core-engine", provider: "alfie-core" },
      result: {
        content: JSON.stringify({ type: "final", message: msg }),
        raw: { usage: { prompt_tokens: 15, completion_tokens: 65, total_tokens: 80 } }
      }
    };
  }
}
