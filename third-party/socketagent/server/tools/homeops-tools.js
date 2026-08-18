#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const HOMEOPS_ROOT = path.resolve(process.env.HOMEOPS_ROOT || "C:\\Users\\kth10\\Documents\\home-ops");
const REMOTE_BASE_URL = (process.env.HOMEOPS_REMOTE_BASE_URL || "http://127.0.0.1:8787").replace(/\/+$/, "");
const REMOTE_PUBLIC_URL = process.env.HOMEOPS_REMOTE_PUBLIC_URL || "https://kevin-pc.taile05f72.ts.net/";
const TOKEN_FILE = process.env.HOMEOPS_REMOTE_TOKEN_FILE || path.join(HOMEOPS_ROOT, "remote-app", "config", "homeops.remote.token.txt");
const POWERSHELL = process.env.SystemRoot
  ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  : "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

const INFRA = Object.freeze({
  router: { name: "Netgear Orbi RBRE960", host: "192.168.1.1" },
  truenas: { name: "TrueNAS / Plex", host: "192.168.1.34", plexPort: 32400 },
  homeAssistant: { name: "Home Assistant OS", host: "192.168.1.93", url: "http://192.168.1.93:8123" },
  controlPc: { name: "Kevin-PC", lanIp: "192.168.1.86", tailscaleIp: "100.97.88.6", magicDns: "kevin-pc.taile05f72.ts.net" },
  phone: { name: "kevins-s24-ultra", tailscaleIp: "100.116.143.19" },
  remoteApp: { localUrl: REMOTE_BASE_URL, publicUrl: REMOTE_PUBLIC_URL },
});

function usage() {
  return `HomeOps SocketAgent tools

Usage:
  node homeops-tools.js status [--text]
  node homeops-tools.js commands
  node homeops-tools.js health
  node homeops-tools.js homeassistant
  node homeops-tools.js lan
  node homeops-tools.js router
  node homeops-tools.js plex-duplicates [status|scan|progress|preview|quarantine]
  node homeops-tools.js plex-duplicates decision <rowId> <approved|swapped|ignored|clear> [reason]
  node homeops-tools.js plex-duplicates verify-item <verificationKey> [verified|clear]
  node homeops-tools.js plex-duplicates issue-item <verificationKey> [issue note]
  node homeops-tools.js plex-duplicates restore-item <verificationKey> RESTORE [issue note]
  node homeops-tools.js plex-duplicates verify-complete [planId]
  node homeops-tools.js plex-duplicates final-delete <planId> DELETE
  node homeops-tools.js message <text>
  node homeops-tools.js ha-dryrun <domain> <service> [entity_id] [json_data]
  node homeops-tools.js ha-apply <domain> <service> APPLY [entity_id] [json_data]
  node homeops-tools.js mcp
`;
}

function readToken() {
  if (!fs.existsSync(TOKEN_FILE)) {
    throw new Error(`HomeOps remote token file not found: ${TOKEN_FILE}`);
  }
  return fs.readFileSync(TOKEN_FILE, "utf8").trim();
}

async function remoteJson(method, route, body) {
  const token = readToken();
  const response = await fetch(`${REMOTE_BASE_URL}${route}`, {
    method,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }
  if (!response.ok) {
    const detail = parsed && (parsed.error || parsed.message || JSON.stringify(parsed));
    throw new Error(`HomeOps remote API ${method} ${route} failed: HTTP ${response.status}${detail ? ` - ${detail}` : ""}`);
  }
  return parsed;
}

async function getStatus() {
  return remoteJson("GET", "/api/status");
}

async function getCommands() {
  return remoteJson("GET", "/api/commands");
}

async function postCommand(action, payload = {}) {
  return remoteJson("POST", "/api/commands", { action, ...payload });
}

function runPowerShellScript(scriptPath, args = [], timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(scriptPath)) {
      reject(new Error(`Script not found: ${scriptPath}`));
      return;
    }

    const child = spawn(POWERSHELL, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...args], {
      cwd: HOMEOPS_ROOT,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const startedAt = new Date();
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Timed out after ${Math.round(timeoutMs / 1000)} seconds: ${scriptPath}`));
    }, timeoutMs);

    child.stdout.on("data", chunk => { stdout += chunk.toString(); });
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.on("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", code => {
      clearTimeout(timer);
      const result = {
        script: scriptPath,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        exitCode: code,
        output: stdout.trim(),
        error: stderr.trim(),
      };
      if (code !== 0) {
        const err = new Error(`PowerShell script failed with exit code ${code}: ${stderr || stdout}`);
        err.result = result;
        reject(err);
        return;
      }
      resolve(result);
    });
  });
}

function homeOpsScript(name) {
  return path.join(HOMEOPS_ROOT, "scripts", name);
}

function remoteAppScript(name) {
  return path.join(HOMEOPS_ROOT, "remote-app", "server", name);
}

async function runAllowlistedAction(action, fallbackScript, fallbackArgs = [], timeoutMs = 120000) {
  try {
    return await postCommand(action);
  } catch (error) {
    const fallback = await runPowerShellScript(fallbackScript, fallbackArgs, timeoutMs);
    return {
      ok: true,
      fallback: true,
      remoteApiError: error.message,
      command: {
        action,
        status: "completed",
        result: fallback,
      },
    };
  }
}

async function runHealthCheck() {
  return runAllowlistedAction("homeops.check", homeOpsScript("Invoke-HomeOpsCheck.ps1"), [], 120000);
}

async function runHomeAssistantMonitor() {
  return runAllowlistedAction("homeassistant.monitor", homeOpsScript("Invoke-HomeAssistantMonitor.ps1"), [], 120000);
}

async function runLanInventory() {
  return runAllowlistedAction("lan.inventory", homeOpsScript("Invoke-LanInventory.ps1"), [], 240000);
}

async function runRouterReadiness() {
  return runPowerShellScript(remoteAppScript("Test-HomeOpsRemoteRouterReadiness.ps1"), [], 120000);
}

async function getPlexDuplicateReport() {
  return remoteJson("GET", "/api/plex/duplicates");
}

async function getPlexDuplicateProgress() {
  return remoteJson("GET", "/api/plex/duplicates/progress");
}

async function runPlexDuplicateScan() {
  return postCommand("plex.duplicates.scan", { text: "Plex duplicate movie scan" });
}

function normalizePlexDecisionAction(action) {
  const text = String(action || "").toLowerCase();
  if (text === "approve") return "approved";
  if (text === "swap") return "swapped";
  if (text === "ignore") return "ignored";
  if (["approved", "swapped", "ignored", "clear"].includes(text)) return text;
  throw new Error("Plex duplicate decision must be approved, swapped, ignored, or clear.");
}

async function setPlexDuplicateDecision(rowId, action, reason = "") {
  return remoteJson("POST", "/api/plex/duplicates/decision", {
    rowId,
    action: normalizePlexDecisionAction(action),
    reason,
  });
}

async function previewPlexDuplicateCleanup(note = "") {
  return remoteJson("POST", "/api/plex/duplicates/cleanup-preview", { note });
}

async function quarantinePlexDuplicateCleanup(note = "") {
  return remoteJson("POST", "/api/plex/duplicates/finalize-cleanup", {
    confirm: "QUARANTINE",
    note,
  });
}

async function setPlexDuplicateVerificationItem(key, verified = true) {
  return remoteJson("POST", "/api/plex/duplicates/verification-item", {
    key,
    verified,
  });
}

async function setPlexDuplicateVerificationIssue(key, note = "") {
  return remoteJson("POST", "/api/plex/duplicates/verification-issue", {
    key,
    issue: true,
    note,
  });
}

async function restorePlexDuplicateVerificationItem(key, confirm, note = "") {
  if (confirm !== "RESTORE") throw new Error("restore-item requires confirm argument RESTORE.");
  return remoteJson("POST", "/api/plex/duplicates/restore-item", {
    key,
    confirm: "RESTORE",
    note,
  });
}

async function completePlexDuplicateVerification(planId = "") {
  const body = {};
  if (planId) body.planId = planId;
  return remoteJson("POST", "/api/plex/duplicates/verification-complete", body);
}

async function approvePlexDuplicateFinalDelete(planId, confirm) {
  if (confirm !== "DELETE") throw new Error("final-delete requires confirm argument DELETE.");
  return remoteJson("POST", "/api/plex/duplicates/final-delete-approval", {
    planId,
    confirm: "DELETE",
    verificationComplete: true,
  });
}

async function queueMessage(text) {
  if (!text || !String(text).trim()) throw new Error("message text is required");
  return postCommand("message", { text: String(text) });
}

async function homeAssistantService(domain, service, entityId, data, apply, confirm) {
  const payload = {
    action: apply ? "homeassistant.service.apply" : "homeassistant.service.dryrun",
    domain,
    service,
  };
  if (entityId) payload.entityId = entityId;
  if (data !== undefined) payload.data = data;
  if (apply) payload.confirm = confirm;
  return remoteJson("POST", "/api/commands", payload);
}

function compactStatus(status) {
  return {
    ok: status && status.ok === true,
    generatedAt: status && status.generatedAt,
    server: status && status.server,
    infrastructure: INFRA,
    actions: status && status.actions,
    homeops: status && status.homeops && status.homeops.data ? {
      generatedAt: status.homeops.data.generatedAt,
      healthy: status.homeops.data.healthy,
      devices: status.homeops.data.devices,
    } : status && status.homeops,
    homeassistant: status && status.homeassistant && status.homeassistant.data ? {
      generatedAt: status.homeassistant.data.generatedAt,
      version: status.homeassistant.data.version,
      entityCount: status.homeassistant.data.entityCount,
      unavailableOrUnknownCount: status.homeassistant.data.unavailableOrUnknownCount,
      lowBatteryCount: status.homeassistant.data.lowBatteryCount,
      unavailableOrUnknown: status.homeassistant.data.unavailableOrUnknown,
      lowBattery: status.homeassistant.data.lowBattery,
    } : status && status.homeassistant,
  };
}

function statusText(status) {
  const compact = compactStatus(status);
  const lines = [];
  lines.push(`HomeOps status generated: ${compact.generatedAt || "unknown"}`);
  lines.push(`Remote API: ${compact.ok ? "ok" : "not ok"} (${REMOTE_BASE_URL})`);
  if (compact.homeops) {
    lines.push(`HomeOps health: ${compact.homeops.healthy === true ? "healthy" : compact.homeops.healthy === false ? "attention needed" : "unknown"}`);
  }
  if (compact.homeassistant) {
    lines.push(`Home Assistant: ${compact.homeassistant.version || "unknown version"}; unavailable/unknown=${compact.homeassistant.unavailableOrUnknownCount ?? "unknown"}; lowBattery=${compact.homeassistant.lowBatteryCount ?? "unknown"}`);
  }
  lines.push(`Router: ${INFRA.router.host}; TrueNAS/Plex: ${INFRA.truenas.host}; Home Assistant: ${INFRA.homeAssistant.host}; Control PC Tailscale: ${INFRA.controlPc.tailscaleIp}`);
  return lines.join("\n");
}

function parseJsonArg(value) {
  if (!value) return undefined;
  return JSON.parse(value);
}

function printJson(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function textResult(value) {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

async function runMcp() {
  const [{ McpServer }, { StdioServerTransport }, { z }] = await Promise.all([
    import("@modelcontextprotocol/sdk/server/mcp.js"),
    import("@modelcontextprotocol/sdk/server/stdio.js"),
    import("zod"),
  ]);

  const server = new McpServer({ name: "homeops", version: "1.0.0" });
  const asText = async fn => ({ content: [{ type: "text", text: textResult(await fn()) }] });

  server.registerTool("HomeOpsStatus", {
    title: "HomeOps Status",
    description: "Read the current HomeOps remote status, infrastructure map, and latest Home Assistant/HomeOps reports.",
    inputSchema: { compact: z.boolean().optional().describe("Return a compact status object. Default true.") },
  }, async args => asText(async () => (args && args.compact === false ? await getStatus() : compactStatus(await getStatus()))));

  server.registerTool("RunHomeOpsCheck", {
    title: "Run HomeOps Check",
    description: "Run the read-only HomeOps health check for router, TrueNAS/Plex, Home Assistant, and LAN reachability.",
    inputSchema: {},
  }, async () => asText(runHealthCheck));

  server.registerTool("RunHomeAssistantMonitor", {
    title: "Run Home Assistant Monitor",
    description: "Run the read-only Home Assistant API/entity/battery monitor.",
    inputSchema: {},
  }, async () => asText(runHomeAssistantMonitor));

  server.registerTool("RunLanInventory", {
    title: "Run LAN Inventory",
    description: "Run the LAN service-port inventory scan for the home network.",
    inputSchema: {},
  }, async () => asText(runLanInventory));

  server.registerTool("GetPlexDuplicateReport", {
    title: "Get Plex Duplicate Report",
    description: "Read the latest Plex duplicate report, including rows, decisions, approved counts, and cleanup plan state.",
    inputSchema: {},
  }, async () => asText(getPlexDuplicateReport));

  server.registerTool("RunPlexDuplicateScan", {
    title: "Run Plex Duplicate Scan",
    description: "Run the read-only Plex duplicate movie scanner and refresh duplicate reports.",
    inputSchema: {},
  }, async () => asText(runPlexDuplicateScan));

  server.registerTool("SetPlexDuplicateDecision", {
    title: "Set Plex Duplicate Decision",
    description: "Mark one Plex duplicate row approved, swapped, ignored, or clear. Approval only marks intent; it does not move or delete files.",
    inputSchema: {
      rowId: z.string().describe("Plex duplicate row id from the latest report."),
      action: z.enum(["approved", "swapped", "ignored", "clear"]).describe("Decision to record for this row. Swapped keeps the candidate and removes the original keep file."),
      reason: z.string().optional().describe("Optional reason or note."),
    },
  }, async args => asText(() => setPlexDuplicateDecision(args.rowId, args.action, args.reason || "")));

  server.registerTool("PreviewPlexDuplicateCleanup", {
    title: "Preview Plex Duplicate Cleanup",
    description: "Build the approved duplicate quarantine plan without moving, deleting, renaming, or editing media.",
    inputSchema: { note: z.string().optional().describe("Optional note to include in the preview.") },
  }, async args => asText(() => previewPlexDuplicateCleanup(args.note || "")));

  server.registerTool("QuarantineApprovedPlexDuplicates", {
    title: "Quarantine Approved Plex Duplicates",
    description: "Move approved Plex duplicate candidates to quarantine and request a Plex rescan. Final deletion remains separately gated.",
    inputSchema: { note: z.string().optional().describe("Optional note for the cleanup plan.") },
  }, async args => asText(() => quarantinePlexDuplicateCleanup(args.note || "")));

  server.registerTool("SetPlexDuplicatePlaybackVerificationItem", {
    title: "Set Plex Duplicate Playback Verification Item",
    description: "Mark one quarantined duplicate cleanup item as playback verified or clear that verification.",
    inputSchema: {
      key: z.string().describe("Verification key from the cleanup plan."),
      verified: z.boolean().optional().describe("True to mark verified, false to clear verification. Default true."),
    },
  }, async args => asText(() => setPlexDuplicateVerificationItem(args.key, args.verified !== false)));

  server.registerTool("SetPlexDuplicatePlaybackIssue", {
    title: "Set Plex Duplicate Playback Issue",
    description: "Record a playback issue for one cleanup item without moving files.",
    inputSchema: {
      key: z.string().describe("Verification key from the cleanup plan."),
      note: z.string().optional().describe("Playback issue note, for example distorted image or file will not play."),
    },
  }, async args => asText(() => setPlexDuplicateVerificationIssue(args.key, args.note || "")));

  server.registerTool("RestorePlexDuplicatePlaybackItem", {
    title: "Restore Plex Duplicate Playback Item",
    description: "Restore one quarantined duplicate and move the failed current file to quarantine. Requires confirm=RESTORE.",
    inputSchema: {
      key: z.string().describe("Verification key from the cleanup plan."),
      confirm: z.literal("RESTORE").describe("Must be exactly RESTORE."),
      note: z.string().optional().describe("Playback issue note."),
    },
  }, async args => asText(() => restorePlexDuplicateVerificationItem(args.key, args.confirm, args.note || "")));

  server.registerTool("CompletePlexDuplicatePlaybackVerification", {
    title: "Complete Plex Duplicate Playback Verification",
    description: "Mark playback verification complete after every cleanup item is individually verified.",
    inputSchema: { planId: z.string().optional().describe("Optional cleanup plan id. Defaults to latest plan.") },
  }, async args => asText(() => completePlexDuplicateVerification(args.planId || "")));

  server.registerTool("ApprovePlexDuplicateFinalDelete", {
    title: "Approve Plex Duplicate Final Delete",
    description: "Delete quarantined Plex duplicate files only after quarantine, rescan, and playback verification are complete. Requires confirm=DELETE.",
    inputSchema: {
      planId: z.string().describe("Cleanup plan id."),
      confirm: z.literal("DELETE").describe("Must be exactly DELETE."),
    },
  }, async args => asText(() => approvePlexDuplicateFinalDelete(args.planId, args.confirm)));

  server.registerTool("RunRouterReadiness", {
    title: "Run Router Readiness",
    description: "Check router model/status, default route, and remote HomeOps API reachability without changing router settings.",
    inputSchema: {},
  }, async () => asText(runRouterReadiness));

  server.registerTool("QueueHomeOpsMessage", {
    title: "Queue HomeOps Message",
    description: "Record a remote HomeOps instruction for review without executing it.",
    inputSchema: { text: z.string().describe("Instruction or note to record in the HomeOps command log.") },
  }, async args => asText(() => queueMessage(args.text)));

  server.registerTool("HomeAssistantServiceDryRun", {
    title: "Home Assistant Service Dry Run",
    description: "Validate and prepare a Home Assistant service call without applying it.",
    inputSchema: {
      domain: z.string().describe("Home Assistant service domain, for example light or switch."),
      service: z.string().describe("Home Assistant service name, for example turn_on."),
      entityId: z.string().optional().describe("Optional entity_id, for example light.kitchen."),
      data: z.record(z.any()).optional().describe("Optional service data object."),
    },
  }, async args => asText(() => homeAssistantService(args.domain, args.service, args.entityId, args.data, false)));

  server.registerTool("HomeAssistantServiceApply", {
    title: "Home Assistant Service Apply",
    description: "Apply a Home Assistant service call only when HomeOps mutating actions are enabled and confirm is exactly APPLY.",
    inputSchema: {
      domain: z.string().describe("Home Assistant service domain."),
      service: z.string().describe("Home Assistant service name."),
      confirm: z.string().describe("Must be exactly APPLY."),
      entityId: z.string().optional().describe("Optional entity_id."),
      data: z.record(z.any()).optional().describe("Optional service data object."),
    },
  }, async args => asText(() => homeAssistantService(args.domain, args.service, args.entityId, args.data, true, args.confirm)));

  await server.connect(new StdioServerTransport());
}

async function main() {
  const cmd = (process.argv[2] || "help").toLowerCase();
  const args = process.argv.slice(3);

  if (cmd === "mcp") return runMcp();
  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(usage());
    return;
  }
  if (cmd === "status") {
    const status = await getStatus();
    if (args.includes("--text")) process.stdout.write(statusText(status) + "\n");
    else printJson(compactStatus(status));
    return;
  }
  if (cmd === "commands") return printJson(await getCommands());
  if (cmd === "health") return printJson(await runHealthCheck());
  if (cmd === "homeassistant" || cmd === "ha-monitor") return printJson(await runHomeAssistantMonitor());
  if (cmd === "lan") return printJson(await runLanInventory());
  if (cmd === "router") return printJson(await runRouterReadiness());
  if (cmd === "plex-duplicates" || cmd === "plex-dupes" || cmd === "plex") {
    const subcommand = (args[0] || "status").toLowerCase();
    if (subcommand === "status" || subcommand === "report") return printJson(await getPlexDuplicateReport());
    if (subcommand === "scan") return printJson(await runPlexDuplicateScan());
    if (subcommand === "progress") return printJson(await getPlexDuplicateProgress());
    if (subcommand === "preview") return printJson(await previewPlexDuplicateCleanup(args.slice(1).join(" ")));
    if (subcommand === "quarantine") return printJson(await quarantinePlexDuplicateCleanup(args.slice(1).join(" ")));
    if (subcommand === "decision") {
      const [, rowId, action, ...reasonParts] = args;
      if (!rowId || !action) throw new Error("plex-duplicates decision requires <rowId> <approved|swapped|ignored|clear> [reason]");
      return printJson(await setPlexDuplicateDecision(rowId, action, reasonParts.join(" ")));
    }
    if (subcommand === "verify-item") {
      const [, key, stateText = "verified"] = args;
      if (!key) throw new Error("plex-duplicates verify-item requires <verificationKey> [verified|clear]");
      return printJson(await setPlexDuplicateVerificationItem(key, stateText.toLowerCase() !== "clear"));
    }
    if (subcommand === "issue-item") {
      const [, key, ...noteParts] = args;
      if (!key) throw new Error("plex-duplicates issue-item requires <verificationKey> [issue note]");
      return printJson(await setPlexDuplicateVerificationIssue(key, noteParts.join(" ")));
    }
    if (subcommand === "restore-item") {
      const [, key, confirm, ...noteParts] = args;
      if (!key || !confirm) throw new Error("plex-duplicates restore-item requires <verificationKey> RESTORE [issue note]");
      return printJson(await restorePlexDuplicateVerificationItem(key, confirm, noteParts.join(" ")));
    }
    if (subcommand === "verify-complete") {
      return printJson(await completePlexDuplicateVerification(args[1] || ""));
    }
    if (subcommand === "final-delete") {
      const [, planId, confirm] = args;
      if (!planId || !confirm) throw new Error("plex-duplicates final-delete requires <planId> DELETE");
      return printJson(await approvePlexDuplicateFinalDelete(planId, confirm));
    }
    throw new Error(`Unknown plex-duplicates subcommand: ${subcommand}\n${usage()}`);
  }
  if (cmd === "message") return printJson(await queueMessage(args.join(" ")));
  if (cmd === "ha-dryrun") {
    const [domain, service, entityId, jsonData] = args;
    if (!domain || !service) throw new Error("ha-dryrun requires <domain> <service> [entity_id] [json_data]");
    return printJson(await homeAssistantService(domain, service, entityId, parseJsonArg(jsonData), false));
  }
  if (cmd === "ha-apply") {
    const [domain, service, confirm, entityId, jsonData] = args;
    if (!domain || !service || !confirm) throw new Error("ha-apply requires <domain> <service> APPLY [entity_id] [json_data]");
    return printJson(await homeAssistantService(domain, service, entityId, parseJsonArg(jsonData), true, confirm));
  }

  throw new Error(`Unknown command: ${cmd}\n${usage()}`);
}

main().catch(error => {
  process.stderr.write((error && error.stack ? error.stack : String(error)) + "\n");
  process.exit(1);
});
