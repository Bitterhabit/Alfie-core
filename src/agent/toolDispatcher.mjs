import Ajv from "ajv";
import addFormats from "ajv-formats";
import { createHash } from "node:crypto";
import { containsUntrustedData, wrapUntrustedData } from "./untrustedData.mjs";

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}
function hashCall(toolId, args) {
  return createHash("sha256").update(JSON.stringify([toolId, stable(args || {})])).digest("hex");
}
function capOutput(value, maxChars = 2000) {
  if (typeof value === "string") return value.length > maxChars ? value.slice(0, maxChars) + "… [truncated]" : value;
  const serialised = JSON.stringify(value);
  if (typeof serialised === "string" && serialised.length > maxChars) {
    const previewLimit = Math.max(0, maxChars - 48);
    return { truncated: true, preview: serialised.slice(0, previewLimit) + "…", originalCharacters: serialised.length };
  }
  return value;
}

export class ToolDispatcher {
  constructor({ registry, permissionStore, pendingActionStore, auditStore = null, now = () => Date.now(), maxOutputChars = 2000 } = {}) {
    if (!registry || !permissionStore || !pendingActionStore) throw new TypeError("ToolDispatcher requires registry, permission store and pending-action store.");
    this.registry = registry;
    this.permissionStore = permissionStore;
    this.pendingActionStore = pendingActionStore;
    this.auditStore = auditStore;
    this.now = now;
    this.maxOutputChars = maxOutputChars;
    this.ajv = new Ajv({ allErrors: true, strict: true, coerceTypes: false, removeAdditional: false, useDefaults: false });
    addFormats(this.ajv);
    this.validators = new Map();
    this.lastCallByTurn = new Map();
  }

  validate(tool, args) {
    let validator = this.validators.get(tool.id);
    if (!validator) {
      validator = this.ajv.compile(structuredClone(tool.inputSchema));
      this.validators.set(tool.id, validator);
    }
    if (!validator(args)) {
      const detail = (validator.errors || []).map((error) => {
        const expected = error.keyword === "format" && error.params?.format === "date"
          ? " Expected ISO-8601 YYYY-MM-DD."
          : error.keyword === "format" && error.params?.format === "date-time"
            ? " Expected an ISO-8601 date-time."
            : "";
        return `${error.instancePath || "arguments"} ${error.message}.${expected}`;
      }).join("; ");
      throw Object.assign(new Error(`Validation failed: ${detail || "arguments do not match the tool schema"}.`), { status: 400, code: "TOOL_VALIDATION_FAILED" });
    }
  }

  async runHandler(tool, args, context, signal) {
    if (signal?.aborted) throw Object.assign(new Error("Tool execution exceeded the turn time budget."), { status: 408 });
    const task = Promise.resolve().then(() => {
      if (signal?.aborted) throw Object.assign(new Error("Tool execution exceeded the turn time budget."), { status: 408 });
      return tool.handler(args, { ...context, signal });
    });
    if (!signal) return task;
    let abortListener;
    const aborted = new Promise((_, reject) => {
      abortListener = () => reject(Object.assign(new Error("Tool execution exceeded the turn time budget."), { status: 408 }));
      signal.addEventListener("abort", abortListener, { once: true });
    });
    try { return await Promise.race([task, aborted]); }
    finally { signal.removeEventListener("abort", abortListener); }
  }

  async dispatch({ userId, toolId, args = {}, turnId, contextMessages = [], signal }) {
    const tool = this.registry.tools.get(toolId);
    if (!tool) throw Object.assign(new Error("Tool is not registered."), { status: 404 });
    const callHash = hashCall(toolId, args);
    const previous = this.lastCallByTurn.get(turnId);
    if (previous === callHash) {
      throw Object.assign(new Error("Repeated identical tool call blocked. Try a different action or finish the response."), { status: 409, code: "DUPLICATE_TOOL_CALL" });
    }
    this.lastCallByTurn.set(turnId, callHash);

    const scopes = await this.permissionStore.list(userId);
    if (!scopes.includes(tool.scope)) throw Object.assign(new Error("This user has not granted the required permission."), { status: 403 });
    this.validate(tool, args);

    const untrustedContext = containsUntrustedData(contextMessages);
    const requiresApproval = tool.risk === "write" || tool.externalAction ||
      (untrustedContext && tool.risk !== "read") ||
      (tool.network && untrustedContext);
    if (requiresApproval) {
      const preview = tool.approvalPreview
        ? String(await tool.approvalPreview(args, { userId, toolId })).slice(0, 500)
        : "";
      const pending = await this.pendingActionStore.create(userId, {
        toolId, arguments: args, argumentsHash: callHash, risk: tool.risk, preview,
        approvalGuard: tool.approvalGuard ? await tool.approvalGuard(args, { userId, toolId }) : null,
        reason: untrustedContext ? "External/untrusted content is present in this turn" : `Tool risk level: ${tool.risk}`
      });
      if (this.auditStore) await this.auditStore.record(userId, {
        event: "tool.approval_requested", actor: "alfie", toolId, actionId: pending.id,
        risk: tool.risk, status: "pending", argumentsHash: callHash,
        detail: "Approval requested; raw arguments intentionally excluded"
      });
      return { status: "awaiting_user_approval", actionId: pending.id, toolId, risk: tool.risk, summary: tool.name, preview: pending.preview, arguments: pending.arguments, reason: pending.reason, expiresAt: new Date(pending.expiresAt).toISOString() };
    }

    const result = await this.runHandler(tool, args, { userId, toolId }, signal);
    const bounded = capOutput(result, this.maxOutputChars);
    return { status: "completed", toolId, result: tool.trust === "external" || tool.untrustedOutput ? wrapUntrustedData(bounded, { maxChars: this.maxOutputChars }) : bounded };
  }

  async approve(userId, actionId) {
    const action = await this.pendingActionStore.take(userId, actionId);
    const tool = this.registry.tools.get(action.toolId);
    if (!tool) throw Object.assign(new Error("The approved tool is no longer registered."), { status: 404 });
    if (hashCall(action.toolId, action.arguments) !== action.argumentsHash) {
      throw Object.assign(new Error("The pending action failed its integrity check."), { status: 409 });
    }
    const scopes = await this.permissionStore.list(userId);
    if (!scopes.includes(tool.scope)) throw Object.assign(new Error("Permission was revoked before this action was approved."), { status: 403 });
    this.validate(tool, action.arguments);
    if (tool.approvalGuard || (action.approvalGuard !== null && action.approvalGuard !== undefined)) {
      let currentGuard;
      try {
        if (!tool.approvalGuard || action.approvalGuard === null || action.approvalGuard === undefined) throw new Error("Approval guard is missing or no longer available.");
        currentGuard = await tool.approvalGuard(action.arguments, { userId, toolId: tool.id });
      } catch {
        if (this.auditStore) {
          try { await this.auditStore.record(userId, {
            event: "tool.approval_stale", actor: "system", toolId: tool.id, actionId,
            risk: tool.risk, status: "stale", argumentsHash: action.argumentsHash,
            detail: "The reviewed resource changed or disappeared before approval"
          }); } catch {}
        }
        throw Object.assign(new Error("The item changed or is no longer available since this action was proposed. Review it again before approving."), {
          status: 409, code: "STALE_APPROVAL"
        });
      }
      if (JSON.stringify(currentGuard) !== JSON.stringify(action.approvalGuard)) {
        if (this.auditStore) {
          try { await this.auditStore.record(userId, {
            event: "tool.approval_stale", actor: "system", toolId: tool.id, actionId,
            risk: tool.risk, status: "stale", argumentsHash: action.argumentsHash,
            detail: "The reviewed resource version changed before approval"
          }); } catch {}
        }
        throw Object.assign(new Error("The item changed since this action was proposed. Review the updated item and create a new approval."), {
          status: 409, code: "STALE_APPROVAL"
        });
      }
    }
    if (this.auditStore) await this.auditStore.record(userId, {
      event: "tool.approval_committing", actor: "user", toolId: tool.id, actionId,
      risk: tool.risk, status: "approved", argumentsHash: action.argumentsHash,
      detail: "Explicit user approval recorded before execution"
    });
    let result;
    try {
      result = await this.runHandler(tool, action.arguments, { userId, toolId: tool.id, approved: true, approvalGuard: action.approvalGuard }, AbortSignal.timeout(30_000));
    } catch (error) {
      if (this.auditStore) {
        try { await this.auditStore.record(userId, {
          event: "tool.approval_failed", actor: "alfie", toolId: tool.id, actionId,
          risk: tool.risk, status: "failed", argumentsHash: action.argumentsHash,
          detail: "Tool execution failed; sensitive arguments are not included"
        }); } catch {}
      }
      throw error;
    }
    if (this.auditStore) {
      try {
        await this.auditStore.record(userId, {
          event: "tool.approval_completed", actor: "alfie", toolId: tool.id, actionId,
          risk: tool.risk, status: "completed", argumentsHash: action.argumentsHash
        });
      } catch (error) {
        throw Object.assign(new Error("The approved action completed, but its audit receipt could not be saved. Check the target state before retrying."), {
          status: 503, code: "AUDIT_RECEIPT_FAILED", actionCompleted: true
        });
      }
    }
    const bounded = capOutput(result, this.maxOutputChars);
    return { status: "completed", actionId, toolId: tool.id, result: tool.trust === "external" || tool.untrustedOutput ? wrapUntrustedData(bounded, { maxChars: this.maxOutputChars }) : bounded };
  }

  async reject(userId, actionId) {
    const result = await this.pendingActionStore.reject(userId, actionId);
    if (this.auditStore) await this.auditStore.record(userId, {
      event: "tool.approval_rejected", actor: "user", actionId,
      status: "rejected", detail: "User rejected the pending action"
    });
    return result;
  }

  resetTurn(turnId) { this.lastCallByTurn.delete(turnId); }
}
