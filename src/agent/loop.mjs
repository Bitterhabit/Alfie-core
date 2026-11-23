import { randomUUID } from "node:crypto";
import { createAssetInterceptorMiddleware } from "./assetMiddleware.mjs";
import { applyCloudPrivacyPolicy, isToolAllowedByVisibility } from "../privacy/policy.mjs";
import { containsUntrustedData } from "./untrustedData.mjs";
import { resolveWorkingMode } from "./workingModes.mjs";
import { resolveLearningMode } from "../profile/store.mjs";

export const MAX_STEPS = 4;
export const WALL_CLOCK_TIMEOUT = 30 * 60 * 1000;
export const MAX_WALL_CLOCK_TIMEOUT = 30 * 60 * 1000;

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

function buildDeterministicProjectBrief({ userText, project, workingMode }) {
  const lower = String(userText || "").toLowerCase();
  const asksProjectStatus = lower.includes("where are we")
    || lower.includes("project status")
    || lower.includes("this project")
    || lower.includes("project brief")
    || lower.includes("blockers")
    || lower.includes("next actions");
  if (!project || !asksProjectStatus) return null;

  const sections = [`### Project Brief: ${project.name} (${project.status || "active"})`];
  if (project.vision) sections.push(`**Vision:** ${project.vision}`);
  if (project.description) sections.push(`**Shared Notes:** ${project.description}`);
  if (project.architecture) sections.push(`**Architecture:** ${project.architecture}`);
  if (project.nextActions?.length) sections.push("**Next Recommended Actions:**\n" + project.nextActions.map((item) => `• ${item}`).join("\n"));
  if (project.blockers?.length) sections.push("**Current Blockers:**\n" + project.blockers.map((item) => `• ${item}`).join("\n"));
  if (project.decisions?.length) sections.push("**Recorded Decisions:**\n" + project.decisions.slice(-5).map((decision) =>
    decision.rationale ? `• **${decision.summary}** — ${decision.rationale}` : `• **${decision.summary}**`
  ).join("\n"));
  if (project.postponed?.length) sections.push("**Deliberately Postponed:**\n" + project.postponed.map((item) => `• ${item}`).join("\n"));
  if (sections.length === 1) {
    sections.push("No Vision, Architecture, Next Actions, Blockers, or Decisions have been recorded in this dossier yet. Open **Dossier** in the chat bar to capture your current state so future briefings stay grounded.");
  }
  sections.push(`*Mode: ${workingMode?.label || "Companion"} · Grounded directly in your Living Project Dossier.*`);
  const message = sections.join("\n\n");
  const completionTokens = Math.max(1, Math.round(message.length / 4));
  return {
    endpoint: { id: "alfie-core-dossier", model: "deterministic-project-brief", provider: "alfie-core" },
    result: {
      content: JSON.stringify({ type: "final", message }),
      raw: { usage: { prompt_tokens: 24, completion_tokens: completionTokens, total_tokens: 24 + completionTokens } }
    }
  };
}

export class AgentLoop {
  constructor({
    providerRegistry,
    providerConfig,
    providerStore = null,
    toolRegistry,
    dispatcher,
    contextAssembler,
    memoryStore = null,
    projectStore = null,
    watcherStore = null,
    profileStore = null,
    cloudAgentStore = null,
    cloudAdapters = null,
    assetsDirectory,
    filePathPrefix = "./assets",
    assetMiddleware = null,
    now = () => Date.now(),
    maxSteps = MAX_STEPS,
    wallClockTimeout = WALL_CLOCK_TIMEOUT
  } = {}) {
    this.providerRegistry = providerRegistry;
    this.providerConfig = providerConfig;
    this.providerStore = providerStore;
    this.toolRegistry = toolRegistry;
    this.dispatcher = dispatcher;
    this.contextAssembler = contextAssembler;
    this.memoryStore = memoryStore;
    this.projectStore = projectStore;
    this.watcherStore = watcherStore;
    this.profileStore = profileStore;
    this.cloudAgentStore = cloudAgentStore;
    this.cloudAdapters = cloudAdapters;
    this.now = now;
    this.maxSteps = Math.min(MAX_STEPS, Math.max(1, maxSteps));
    this.wallClockTimeout = Math.min(MAX_WALL_CLOCK_TIMEOUT, Math.max(1000, wallClockTimeout));
    this.assetMiddleware = assetMiddleware || dispatcher?.assetMiddleware || createAssetInterceptorMiddleware({
      assetsDirectory,
      filePathPrefix,
      now
    });
  }

  async run({ userId, messages, dashboardState = {}, mode = "auto", workingMode = "companion", projectId = null, agentProvider = "local", turnId = randomUUID(), signal: parentSignal, onProgress }) {
    const started = this.now();
    const controller = new AbortController();
    const abortFromParent = () => controller.abort(parentSignal?.reason || new Error("Client disconnected."));
    if (parentSignal?.aborted) abortFromParent();
    else parentSignal?.addEventListener("abort", abortFromParent, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("Alfie turn exceeded its configured execution budget.")), this.wallClockTimeout);
    timer.unref?.();

    const requestedProvider = ["gemini", "openai"].includes(agentProvider) ? agentProvider : "local";
    let cloudAgent = null;
    if (requestedProvider !== "local") {
      if (!this.cloudAgentStore || !this.cloudAdapters) {
        clearTimeout(timer);
        parentSignal?.removeEventListener("abort", abortFromParent);
        throw Object.assign(new Error("Cloud coding agents are not configured on this Alfie Core instance."), { status: 503 });
      }
      cloudAgent = await this.cloudAgentStore.getAgent(userId, requestedProvider);
      if (!cloudAgent.privacyWarningAccepted || !cloudAgent.enabled) {
        clearTimeout(timer);
        parentSignal?.removeEventListener("abort", abortFromParent);
        throw Object.assign(
          new Error(`Enable ${cloudAgent.name} and acknowledge its privacy warning in Settings before using it in chat.`),
          { status: 403, code: "CLOUD_AGENT_DISABLED" }
        );
      }
    }

    const history = messages.slice(-16).map((message) => ({ role: message.role, content: String(message.content || "").slice(0, 12000) }));
    const userText = [...history].reverse().find((message) => message.role === "user")?.content || "";

    const resolvedMode = resolveWorkingMode(workingMode);

    // Enforce privacy BEFORE even querying ProjectStore or MemoryStore when using a cloud agent.
    let activeProject = null;
    const allowProject = !cloudAgent || cloudAgent.visibility?.allowProjectContext !== false;
    if (allowProject && projectId && this.projectStore?.get) {
      try {
        activeProject = await awaitWithAbort(this.projectStore.get(userId, projectId), controller.signal);
      } catch (error) {
        if (controller.signal.aborted) throw error;
        activeProject = null;
      }
    }

    let memories = [];
    const shouldSearchMemories = !cloudAgent || cloudAgent.visibility?.allowPersonalMemories === true;
    if (shouldSearchMemories && this.memoryStore?.search) {
      try {
        memories = await awaitWithAbort(this.memoryStore.search(userId, userText, { limit: 6 }), controller.signal);
      } catch (error) {
        if (controller.signal.aborted) throw error;
        // Memory retrieval is useful context, not a dependency that should take chat offline.
        memories = [];
      }
    }

    let workflowProfile = null;
    if (this.profileStore?.get) {
      try {
        workflowProfile = await awaitWithAbort(this.profileStore.get(userId), controller.signal);
      } catch (error) {
        if (controller.signal.aborted) throw error;
        workflowProfile = null;
      }
    }

    let previousCall = null;
    let steps = 0;
    const toolsUsed = [];
    let lastPrivacyReport = null;
    let lastShortlistedTools = [];
    let turnTainted = false;
    try {
      while (steps < this.maxSteps) {
        if (controller.signal.aborted || this.now() - started >= this.wallClockTimeout) {
          this.dispatcher.resetTurn(turnId);
          return { status: "timeout", message: `I reached the ${Math.ceil(this.wallClockTimeout / 60000)}-minute processing limit. Please ask me to continue or split the task.`, steps };
        }
        const grantedScopes = await this.dispatcher.permissionStore.list(userId, { projectId: activeProject?.id || null });
        let effectiveDashboardState = dashboardState;
        let effectiveMemories = memories;
        let effectiveScopes = grantedScopes;
        let effectiveHistory = history;
        let privacyNotice = "";

        if (cloudAgent) {
          const policyResult = applyCloudPrivacyPolicy({
            provider: cloudAgent.provider,
            model: cloudAgent.model,
            visibility: cloudAgent.visibility,
            dashboardState,
            memories,
            grantedScopes,
            toolRegistry: this.toolRegistry,
            history
          });
          effectiveDashboardState = policyResult.dashboardState;
          effectiveMemories = policyResult.memories;
          effectiveScopes = policyResult.grantedScopes;
          effectiveHistory = policyResult.history;
          privacyNotice = policyResult.systemNotice;
          lastPrivacyReport = policyResult.privacyReport;
        }

        const context = this.contextAssembler.assemble({
          userText,
          history: effectiveHistory,
          dashboardState: effectiveDashboardState,
          memories: effectiveMemories,
          registry: this.toolRegistry,
          grantedScopes: effectiveScopes,
          privacyNotice,
          workingMode: resolvedMode.id,
          project: activeProject,
          workflowProfile
        });
        lastShortlistedTools = Array.isArray(context.tools) ? context.tools.map((tool) => tool.id) : [];
        if (containsUntrustedData(context.messages)) {
          turnTainted = true;
        }

        let selected;
        if (cloudAgent) {
          selected = await awaitWithAbort(
            this.cloudAdapters.complete({
              provider: cloudAgent.provider,
              model: cloudAgent.model,
              messages: context.messages,
              hasTools: context.tools.length > 0,
              signal: controller.signal
            }),
            controller.signal
          );
        } else {
          try {
            const activeProviderConfig = this.providerStore
              ? (await this.providerStore.getEffectiveConfig(userId)).config
              : this.providerConfig;
            selected = await awaitWithAbort(this.providerRegistry.complete(activeProviderConfig, context.messages, mode, { signal: controller.signal }), controller.signal);
          } catch (providerError) {
            if (controller.signal.aborted) throw providerError;
            selected = buildDeterministicProjectBrief({
              userText,
              project: activeProject,
              workingMode: resolvedMode
            });
            if (!selected) {
              this.dispatcher.resetTurn(turnId);
              return {
                status: "provider_unavailable",
                message: "I couldn't reach a configured model provider, so I haven't generated a response or taken any action. Check the model connection in Settings and try again.",
                steps,
                provider: "local"
              };
            }
          }
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
          const resolvedLearning = workflowProfile ? resolveLearningMode(workflowProfile.learningMode) : null;
          const provenance = {
            workingMode: { id: resolvedMode.id, label: resolvedMode.label },
            learningMode: resolvedLearning ? { id: resolvedLearning.id, label: resolvedLearning.label } : null,
            project: activeProject ? { id: activeProject.id, name: activeProject.name, status: activeProject.status || "active" } : null,
            memoriesInjected: effectiveMemories.slice(0, 6).map((m) => ({
              id: String(m.id || "").slice(0, 64),
              title: String(m.title || m.text || "Memory").slice(0, 80),
              kind: String(m.kind || m.type || "note").slice(0, 40),
              trust: String(m.trust || m.provenance?.trust || "user_authored").slice(0, 40),
              importance: Math.max(1, Math.min(10, Number(m.importance) || 5))
            })),
            toolsShortlisted: lastShortlistedTools,
            toolsUsed: toolsUsed.map((t) => t.toolId),
            tainted: turnTainted || effectiveMemories.some((m) => (m.trust || m.provenance?.trust) === "external_untrusted"),
            privacyFiltered: Boolean(lastPrivacyReport),
            blockedCategories: Array.isArray(lastPrivacyReport?.blockedPersonalCategories) ? lastPrivacyReport.blockedPersonalCategories : [],
            steps,
            latencyMs
          };
          return {
            status: "completed",
            message: action.message.slice(0, 12000),
            steps,
            model: selected.endpoint?.model,
            provider: selected.endpoint?.provider,
            endpointId: selected.endpoint?.id,
            metrics: { latencyMs, completionTokens, promptTokens, totalTokens },
            provenance,
            ...(lastPrivacyReport ? { privacyReport: lastPrivacyReport } : {}),
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

        // Defense-in-depth: block cloud agent from invoking any tool restricted by user's privacy policy
        // even if that scope is granted for local Alfie use.
        if (cloudAgent && (!toolDef || !isToolAllowedByVisibility(toolDef, cloudAgent.visibility))) {
          history.push({ role: "assistant", content: JSON.stringify(action).slice(0, 2000) });
          history.push({
            role: "user",
            content: JSON.stringify({
              error: `Tool "${action.tool}" is blocked by the user's cloud agent privacy policy for ${cloudAgent.name}. Do not attempt to access restricted personal data.`
            })
          });
          continue;
        }

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
            userId, toolId: action.tool, args: action.arguments, turnId, contextMessages: context.messages, projectId: activeProject?.id || null, signal: controller.signal
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
      if (controller.signal.aborted) return { status: "timeout", message: `I reached the ${Math.ceil(this.wallClockTimeout / 60000)}-minute processing limit.`, steps };
      throw error;
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abortFromParent);
    }
  }


}
