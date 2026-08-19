import { createServer } from "node:http";
import { createHash, timingSafeEqual, randomUUID } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { spawn } from "node:child_process";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const remoteRoot = path.resolve(__dirname, "..");
const appRoot = path.join(remoteRoot, "app");
const defaultConfigPath = path.join(remoteRoot, "config", "homeops.remote.json");
const powershellPath = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

const args = parseArgs(process.argv.slice(2));
const configPath = path.resolve(args.config || args.configPath || defaultConfigPath);
const config = JSON.parse(stripBom(readFileSync(configPath, "utf8")));
const homeOpsRoot = path.resolve(config.homeOpsRoot || path.join(remoteRoot, ".."));
const reportsRoot = path.join(homeOpsRoot, "reports");
const scriptsRoot = path.join(homeOpsRoot, "scripts");
const commandLogPath = config.commandLogPath || path.join(homeOpsRoot, "logs", "remote-commands.jsonl");
const plexDuplicateDecisionsPath = path.join(homeOpsRoot, "logs", "plex-duplicate-decisions.json");
const startedAt = new Date();

if (!config.tokenHash || String(config.tokenHash).startsWith("replace-")) {
  throw new Error("Remote token hash is not configured. Run New-HomeOpsRemoteToken.ps1 first.");
}

if (args["check-config"]) {
  console.log(JSON.stringify({
    ok: true,
    configPath,
    homeOpsRoot,
    listenPrefixes: getListenPrefixes(),
    tokenHashLength: String(config.tokenHash).length,
    openaiApiConfigured: Boolean(process.env.OPENAI_API_KEY)
  }, null, 2));
  process.exit(0);
}

const servers = [];
startServers(getListenPrefixes());

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function stripBom(text) {
  return String(text).replace(/^\uFEFF/, "");
}
function parseArgs(rawArgs) {
  const parsed = {};
  for (let i = 0; i < rawArgs.length; i++) {
    const item = rawArgs[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = rawArgs[i + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      i++;
    }
  }
  return parsed;
}

function getListenPrefixes() {
  const prefixes = Array.isArray(config.listenPrefixes) ? config.listenPrefixes : ["http://127.0.0.1:8787/"];
  return prefixes.map(String).filter((value) => value.trim().length > 0);
}

function prefixToEndpoint(prefix) {
  const url = new URL(prefix);
  const host = url.hostname === "localhost" ? "127.0.0.1" : url.hostname;
  return { host, port: Number(url.port || 80) };
}

function startServers(prefixes) {
  let pending = prefixes.length;
  let active = 0;

  if (pending === 0) {
    console.error("HomeOps Remote has no listen prefixes configured.");
    process.exit(1);
  }

  for (const prefix of prefixes) {
    const endpoint = prefixToEndpoint(prefix);
    const server = createServer(handleRequest);
    let settled = false;

    function settleListening() {
      if (settled) return;
      settled = true;
      pending -= 1;
      active += 1;
      servers.push(server);
      console.log(`HomeOps Remote listening on http://${endpoint.host}:${endpoint.port}/`);
      exitIfNoListenersRemain(pending, active);
    }

    function settleError(error) {
      if (settled) return;
      settled = true;
      pending -= 1;
      console.error(`HomeOps Remote could not listen on ${prefix}: ${error.message}`);
      exitIfNoListenersRemain(pending, active);
    }

    server.once("listening", settleListening);
    server.once("error", settleError);
    server.listen(endpoint.port, endpoint.host);
  }
}

function exitIfNoListenersRemain(pending, active) {
  if (pending === 0 && active === 0) {
    console.error("HomeOps Remote could not start any configured listener.");
    process.exit(1);
  }
}

async function shutdown() {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  process.exit(0);
}

async function handleRequest(req, res) {
  try {
    setCommonHeaders(res);
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }

    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }
    await serveStatic(res, url.pathname);
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error.message });
  }
}

function setCommonHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-HomeOps-Token");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

async function handleApi(req, res, url) {
  const remoteAddress = normalizeRemoteAddress(req.socket.remoteAddress || "");
  if (!isRemoteAllowed(remoteAddress)) {
    sendJson(res, 403, { ok: false, error: `Remote address is not allowed: ${remoteAddress}` });
    return;
  }

  if (req.method === "POST" && url.pathname.replace(/\/+$/, "") === "/api/gym-tracker/feedback") {
    try {
      const body = await readJsonBody(req);
      const result = await createGymTrackerGitHubIssue(body, remoteAddress);
      sendJson(res, 201, result);
    } catch (error) {
      sendJson(res, getGymTrackerFeedbackErrorStatus(error), { ok: false, error: error.message });
    }
    return;
  }

  if (!isTokenValid(getRequestToken(req))) {
    sendJson(res, 401, { ok: false, error: "Missing or invalid HomeOps Remote token." });
    return;
  }

  const route = url.pathname.replace(/\/+$/, "");
  if (req.method === "GET" && route === "/api/status") {
    sendJson(res, 200, await getStatusPayload());
    return;
  }
  if (req.method === "GET" && route === "/api/commands") {
    sendJson(res, 200, { ok: true, commands: await getRecentCommandLog() });
    return;
  }
  if (req.method === "GET" && route === "/api/plex/duplicates") {
    sendJson(res, 200, { ok: true, report: await getPlexDuplicateReport() });
    return;
  }
  if (req.method === "GET" && route === "/api/plex/duplicates/progress") {
    sendJson(res, 200, { ok: true, progress: await getPlexDuplicateCleanupProgress() });
    return;
  }
  if (req.method === "POST" && route === "/api/plex/duplicates/decision") {
    try {
      const body = await readJsonBody(req);
      const decision = await setPlexDuplicateDecision(body, remoteAddress);
      sendJson(res, 200, { ok: true, decision, report: await getPlexDuplicateReport() });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }
  if (req.method === "POST" && route === "/api/plex/duplicates/cleanup-preview") {
    try {
      const body = await readJsonBody(req);
      const plan = await previewPlexDuplicateCleanupPlan(body, remoteAddress);
      sendJson(res, 200, { ok: true, plan, report: await getPlexDuplicateReport() });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }
  if (req.method === "POST" && route === "/api/plex/duplicates/finalize-cleanup") {
    try {
      const body = await readJsonBody(req);
      const plan = await finalizePlexDuplicateCleanupPlan(body, remoteAddress);
      sendJson(res, 201, { ok: true, plan, report: await getPlexDuplicateReport() });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }
  if (req.method === "POST" && route === "/api/plex/duplicates/verification-complete") {
    try {
      const body = await readJsonBody(req);
      const plan = await markPlexCleanupVerificationComplete(body, remoteAddress);
      sendJson(res, 200, { ok: true, plan, report: await getPlexDuplicateReport() });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }
  if (req.method === "POST" && route === "/api/plex/duplicates/verification-item") {
    try {
      const body = await readJsonBody(req);
      const plan = await setPlexCleanupVerificationItem(body, remoteAddress);
      sendJson(res, 200, { ok: true, plan, report: await getPlexDuplicateReport() });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }
  if (req.method === "POST" && route === "/api/plex/duplicates/verification-issue") {
    try {
      const body = await readJsonBody(req);
      const plan = await setPlexCleanupVerificationIssue(body, remoteAddress);
      sendJson(res, 200, { ok: true, plan, report: await getPlexDuplicateReport() });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }
  if (req.method === "POST" && route === "/api/plex/duplicates/restore-item") {
    try {
      const body = await readJsonBody(req);
      const plan = await restorePlexCleanupVerificationItem(body, remoteAddress);
      sendJson(res, 200, { ok: true, plan, report: await getPlexDuplicateReport() });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }
  if (req.method === "POST" && route === "/api/plex/duplicates/final-delete-approval") {
    try {
      const body = await readJsonBody(req);
      const approval = await recordPlexFinalDeleteApproval(body, remoteAddress);
      sendJson(res, 201, { ok: true, approval, report: await getPlexDuplicateReport() });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }
  if (req.method === "POST" && route === "/api/plex/duplicates/approve") {
    const body = await readJsonBody(req);
    const approval = await approvePlexDuplicateReport(body, remoteAddress);
    sendJson(res, 201, { ok: true, approval, report: await getPlexDuplicateReport() });
    return;
  }
  if (req.method === "POST" && route === "/api/commands") {
    const body = await readJsonBody(req);
    const command = await invokeRemoteCommand(body, remoteAddress);
    sendJson(res, command.status === "failed" ? 400 : 200, {
      ok: command.status !== "failed",
      command,
      status: await getStatusPayload()
    });
    return;
  }

  sendJson(res, 404, { ok: false, error: `Unknown API route: ${req.method} ${route}` });
}

const gymTrackerFeedbackLimits = new Map();

async function createGymTrackerGitHubIssue(body, remoteAddress) {
  enforceGymTrackerFeedbackRateLimit(remoteAddress);
  const issue = validateGymTrackerIssuePayload(body);
  const token = await getGymTrackerGitHubToken();
  if (!token) {
    throw new Error("Gym Tracker GitHub issue token is not configured on the HomeOps server.");
  }

  const githubResult = await postGitHubJson(
    "/repos/kth1022/gym-tracker-android/issues",
    {
      title: issue.title,
      body: issue.body,
      labels: issue.labels
    },
    token
  );

  const issueNumber = githubResult.number || 0;
  const issueUrl = githubResult.html_url || "";
  try {
    await appendFile(commandLogPath, JSON.stringify({
      id: randomUUID().replaceAll("-", ""),
      receivedAt: new Date().toISOString(),
      remoteAddress,
      action: "gymtracker.feedback",
      status: "completed",
      issueNumber,
      issueUrl,
      title: issue.title.slice(0, 160)
    }) + "\n", "utf8");
  } catch {
    // The GitHub issue was created; local logging should not make the app retry it.
  }

  return {
    ok: true,
    issue: {
      number: issueNumber,
      url: issueUrl
    }
  };
}

function enforceGymTrackerFeedbackRateLimit(remoteAddress) {
  const key = String(remoteAddress || "unknown");
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;
  const maxRequests = 12;
  const current = gymTrackerFeedbackLimits.get(key) || [];
  const recent = current.filter((timestamp) => now - timestamp < windowMs);
  if (recent.length >= maxRequests) {
    const error = new Error("Gym Tracker feedback rate limit reached. Try again later.");
    error.statusCode = 429;
    throw error;
  }
  recent.push(now);
  gymTrackerFeedbackLimits.set(key, recent);
}

function validateGymTrackerIssuePayload(body) {
  if (!body || body.type !== "GymTrackerGitHubIssueSubmitV1") {
    const error = new Error("Invalid Gym Tracker feedback payload.");
    error.statusCode = 400;
    throw error;
  }
  if (String(body.repo || "") !== "kth1022/gym-tracker-android") {
    const error = new Error("Invalid feedback target repository.");
    error.statusCode = 400;
    throw error;
  }

  const title = stringValue(body.title).trim();
  const issueBody = stringValue(body.body).trim();
  if (title.length < 5 || title.length > 180) {
    const error = new Error("Feedback title must be 5 to 180 characters.");
    error.statusCode = 400;
    throw error;
  }
  if (issueBody.length < 5 || issueBody.length > 60000) {
    const error = new Error("Feedback body must be 5 to 60000 characters.");
    error.statusCode = 400;
    throw error;
  }

  const allowedLabels = new Set(["user feedback", "feature request", "bug", "data recovery", "feedback"]);
  const labels = asArray(body.labels)
    .map((label) => stringValue(label).trim())
    .filter((label) => allowedLabels.has(label));
  if (!labels.includes("user feedback")) labels.unshift("user feedback");

  return {
    title,
    body: issueBody,
    labels: [...new Set(labels)]
  };
}

function getGymTrackerFeedbackErrorStatus(error) {
  if (Number.isInteger(error?.statusCode)) return error.statusCode;
  const message = stringValue(error?.message);
  if (message.includes("not configured")) return 503;
  if (message.includes("GitHub issue creation failed")) return 502;
  return 500;
}

async function getGymTrackerGitHubToken() {
  const fromEnv = stringValue(process.env.GYM_TRACKER_GITHUB_TOKEN).trim();
  if (fromEnv) return fromEnv;

  const configuredPath = stringValue(config.gymTrackerGitHubTokenPath).trim();
  const tokenPaths = [
    configuredPath,
    path.join(remoteRoot, "config", "gymtracker.github.token.txt"),
    path.join(homeOpsRoot, ".secrets", "gym-tracker", "github-issues-token.txt")
  ].filter(Boolean);

  for (const tokenPath of tokenPaths) {
    try {
      if (existsSync(tokenPath)) {
        const token = stripBom(await readFile(tokenPath, "utf8")).trim();
        if (token) return token;
      }
    } catch {
      // Try the next configured token source.
    }
  }

  const credentialTarget = stringValue(config.gymTrackerGitHubCredentialTarget || "Gym_Traker_Issues_Token").trim();
  if (credentialTarget) {
    const credentialToken = await readWindowsCredentialSecret(credentialTarget);
    if (credentialToken) return credentialToken;
  }
  return await readGitCredentialManagerToken();
}

function readWindowsCredentialSecret(target) {
  return new Promise((resolve) => {
    const script = `
$target = ${JSON.stringify(target)}
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class CredReader {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL {
    public UInt32 Flags;
    public UInt32 Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob;
    public UInt32 Persist;
    public UInt32 AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredRead(string target, UInt32 type, UInt32 reservedFlag, out IntPtr credentialPtr);
  [DllImport("advapi32.dll", SetLastError=true)]
  public static extern void CredFree(IntPtr buffer);
  public static string ReadGeneric(string target) {
    IntPtr ptr;
    if (!CredRead(target, 1, 0, out ptr)) return "";
    try {
      CREDENTIAL credential = (CREDENTIAL)Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));
      if (credential.CredentialBlob == IntPtr.Zero || credential.CredentialBlobSize == 0) return "";
      return Marshal.PtrToStringUni(credential.CredentialBlob, (int)credential.CredentialBlobSize / 2);
    } finally {
      CredFree(ptr);
    }
  }
}
"@
[CredReader]::ReadGeneric($target)
`;
    const child = spawn(powershellPath, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
      cwd: homeOpsRoot,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"]
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      resolve(code === 0 ? stdout.trim() : "");
    });
    child.on("error", () => resolve(""));
  });
}

function readGitCredentialManagerToken() {
  return new Promise((resolve) => {
    const child = spawn("git", ["credential", "fill"], {
      cwd: homeOpsRoot,
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"]
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      if (code !== 0) {
        resolve("");
        return;
      }
      const lines = stdout.split(/\r?\n/);
      const passwordLine = lines.find((line) => line.startsWith("password="));
      resolve(passwordLine ? passwordLine.slice("password=".length).trim() : "");
    });
    child.on("error", () => resolve(""));
    child.stdin.end("protocol=https\nhost=github.com\npath=kth1022/gym-tracker-android.git\n\n");
  });
}

function postGitHubJson(apiPath, payload, token) {
  const json = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = httpsRequest({
      hostname: "api.github.com",
      path: apiPath,
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "HomeOps-GymTrackerFeedback",
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(json)
      }
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed = {};
        try {
          parsed = text ? JSON.parse(text) : {};
        } catch {
          parsed = { message: text.slice(0, 500) };
        }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(parsed);
        } else {
          reject(new Error(`GitHub issue creation failed (${res.statusCode}): ${stringValue(parsed.message).slice(0, 240)}`));
        }
      });
    });
    req.setTimeout(30000, () => req.destroy(new Error("GitHub issue creation timed out.")));
    req.on("error", reject);
    req.end(json);
  });
}

function normalizeRemoteAddress(value) {
  return value.startsWith("::ffff:") ? value.slice(7) : value;
}

function getRequestToken(req) {
  const authorization = req.headers.authorization || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (match) return match[1].trim();
  return String(req.headers["x-homeops-token"] || "").trim();
}

function isTokenValid(token) {
  if (!token) return false;
  const actual = Buffer.from(sha256(token), "hex");
  const expected = Buffer.from(String(config.tokenHash), "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isRemoteAllowed(address) {
  const direct = new Set((config.allowedRemoteAddresses || []).map(String));
  if (direct.has(address)) return true;
  return (config.allowedRemoteCidrs || []).some((cidr) => ipv4InCidr(address, String(cidr)));
}

function ipv4InCidr(address, cidr) {
  const [network, bitsText] = cidr.split("/");
  const bits = Number(bitsText);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const addrInt = ipv4ToInt(address);
  const networkInt = ipv4ToInt(network);
  if (addrInt === null || networkInt === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (addrInt & mask) === (networkInt & mask);
}

function ipv4ToInt(value) {
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 1024 * 1024) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

async function serveStatic(res, requestPath) {
  const pathname = decodeURIComponent(requestPath === "/" ? "/index.html" : requestPath);
  const fullPath = path.resolve(appRoot, `.${pathname}`);
  const relativePath = path.relative(appRoot, fullPath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    sendText(res, 403, "Forbidden");
    return;
  }
  if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
    sendText(res, 404, "Not found");
    return;
  }

  res.writeHead(200, {
    "Content-Type": getContentType(fullPath),
    "Cache-Control": /\.(html|js|css|webmanifest)$/i.test(fullPath) ? "no-cache" : "public, max-age=3600"
  });
  createReadStream(fullPath).pipe(res);
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".svg": "image/svg+xml"
  }[ext] || "application/octet-stream";
}

function sendJson(res, statusCode, body) {
  const json = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(json);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

async function getStatusPayload() {
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    server: {
      computer: process.env.COMPUTERNAME || "",
      startedAt: startedAt.toISOString(),
      homeOpsRoot,
      listenPrefixes: getListenPrefixes(),
      allowMutatingActions: Boolean(config.allowMutatingActions),
      openaiApiConfigured: Boolean(process.env.OPENAI_API_KEY)
    },
    actions: getActionManifest(),
    homeops: await getCompactHomeOpsReport(),
    homeassistant: await getCompactHomeAssistantReport(),
    plexDuplicates: await getPlexDuplicateReport(),
    summaries: {
      homeops: await getTextReport("homeops-latest.md"),
      homeassistant: await getTextReport("homeassistant-latest.md")
    }
  };
}

function getActionManifest() {
  return [
    { id: "homeops.check", label: "HomeOps Check", description: "Refresh router, TrueNAS/Plex, and Home Assistant reachability.", mutating: false },
    { id: "homeassistant.monitor", label: "Home Assistant Monitor", description: "Refresh Home Assistant API, entity, service, and battery summary.", mutating: false },
    { id: "lan.inventory", label: "LAN Inventory", description: "Scan known LAN service ports and write an inventory report.", mutating: false },
    { id: "plex.duplicates.scan", label: "Plex Duplicates", description: "Scan Plex movie libraries and refresh the duplicate movie report.", mutating: false },
    { id: "plex.duplicates.finalize-cleanup", label: "Plex Quarantine", description: "Move approved duplicate candidates to quarantine only when local config permits mutating actions.", mutating: true, enabled: Boolean(config.allowMutatingActions) },
    { id: "plex.duplicates.restore-item", label: "Plex Restore", description: "Restore a quarantined duplicate only when local config permits mutating actions.", mutating: true, enabled: Boolean(config.allowMutatingActions) },
    { id: "plex.duplicates.final-delete-approval", label: "Plex Final Cleanup", description: "Restore issue-marked movies and delete approved quarantine files only when local config permits mutating actions.", mutating: true, enabled: Boolean(config.allowMutatingActions) },
    { id: "homeassistant.service.dryrun", label: "HA Service Dry Run", description: "Prepare a Home Assistant service call without applying it.", mutating: false },
    { id: "homeassistant.service.apply", label: "HA Service Apply", description: "Apply a Home Assistant service call only when local config permits it.", mutating: true, enabled: Boolean(config.allowMutatingActions) },
    { id: "message", label: "Message", description: "Record a remote instruction for review.", mutating: false }
  ];
}

function assertMutatingActionsAllowed(actionLabel) {
  if (!config.allowMutatingActions) {
    throw new Error(`${actionLabel} is disabled because allowMutatingActions is false in the local HomeOps Remote config.`);
  }
}

async function getPlexDuplicateReport() {
  const report = await getLatestJsonReport(/^plex-duplicate-movies-(?:latest|\d{8}T\d{6}Z)\.json$/);
  if (!report?.data) return report;
  const data = report.data;
  const decisions = await readPlexDuplicateDecisions();
  const rows = [];
  for (const group of asArray(data.groups)) {
    for (const candidate of asArray(group.candidates)) {
      const rowId = stringValue(candidate.rowId || plexDuplicateRowId(group, group.keep, candidate));
      const decision = decisions.decisions[rowId] || null;
      const swapped = decision?.action === "swapped";
      const keepFiles = versionFiles(group.keep);
      const candidateFiles = versionFiles(candidate);
      const pairFingerprint = candidate.pairFingerprint || plexDuplicatePairFingerprint(keepFiles, candidateFiles);
      rows.push({
        rowId,
        group: group.index,
        groupFingerprint: candidate.groupFingerprint || group.groupFingerprint || "",
        pairFingerprint,
        groupFiles: asArray(group.groupFiles),
        title: group.title,
        library: group.keep?.movie?.library || "",
        keepQuality: group.keep?.quality || "",
        keepScore: group.keep?.score || 0,
        keepFiles,
        candidateQuality: candidate.quality || "",
        candidateScore: candidate.score || 0,
        candidateFiles,
        cleanupKeepFiles: swapped ? candidateFiles : keepFiles,
        cleanupCandidateFiles: swapped ? keepFiles : candidateFiles,
        cleanupMode: swapped ? "swap" : "candidate",
        confidence: candidate.confidence || "",
        reason: candidate.reason || "",
        decision: decision ? {
          action: decision.action,
          reason: decision.reason || "",
          note: decision.note || "",
          updatedAt: decision.updatedAt || ""
        } : null
      });
    }
  }
  const approvedRows = rows.filter((row) => ["approved", "swapped"].includes(row.decision?.action)).length;
  const swappedRows = rows.filter((row) => row.decision?.action === "swapped").length;
  const ignoredRows = rows.filter((row) => row.decision?.action === "ignored").length;

  return {
    path: report.path,
    generatedAt: data.generatedAt || report.generatedAt,
    safety: data.safety || "read-only report",
    summary: {
      ...(data.summary || {}),
      approvedRows,
      swappedRows,
      ignoredRows
    },
    files: {
      json: report.path,
      markdown: path.join(reportsRoot, "plex-duplicate-movies-latest.md"),
      html: path.join(reportsRoot, "plex-duplicate-movies-latest.html"),
      csv: path.join(reportsRoot, "plex-duplicate-movies-latest.csv")
    },
    approved: await getLatestPlexDuplicateApproval(data.generatedAt || report.generatedAt, report.path),
    cleanupPlan: await getLatestPlexCleanupPlan(),
    rows
  };
}

function versionFiles(version) {
  return asArray(version?.parts).map((part) => stringValue(part.file)).filter(Boolean);
}

function stableHash(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex").slice(0, 20);
}

function sortedUnique(values) {
  return [...new Set(asArray(values).map((value) => stringValue(value).trim()).filter(Boolean))].sort();
}

function plexDuplicateRowId(group, keep, candidate) {
  return stableHash([
    ...sortedUnique(group?.keys),
    "keep",
    ...sortedUnique(versionFiles(keep)),
    "candidate",
    ...sortedUnique(versionFiles(candidate)),
  ].join("\n"));
}

function plexDuplicatePairFingerprint(keepFiles, candidateFiles) {
  return stableHash([
    "keep",
    ...sortedUnique(keepFiles),
    "candidate",
    ...sortedUnique(candidateFiles)
  ].join("\n"));
}

async function readPlexDuplicateDecisions() {
  if (!existsSync(plexDuplicateDecisionsPath)) {
    return { version: 1, updatedAt: null, decisions: {}, cleanupPlans: [] };
  }
  try {
    const parsed = JSON.parse(stripBom(await readFile(plexDuplicateDecisionsPath, "utf8")));
    return {
      version: parsed.version || 1,
      updatedAt: parsed.updatedAt || null,
      decisions: parsed.decisions && typeof parsed.decisions === "object" ? parsed.decisions : {},
      cleanupPlans: Array.isArray(parsed.cleanupPlans) ? parsed.cleanupPlans : []
    };
  } catch (error) {
    throw new Error(`Failed to read Plex duplicate decisions: ${error.message}`);
  }
}

async function writePlexDuplicateDecisions(store) {
  await mkdir(path.dirname(plexDuplicateDecisionsPath), { recursive: true });
  const next = {
    version: 1,
    updatedAt: new Date().toISOString(),
    decisions: store.decisions || {},
    cleanupPlans: Array.isArray(store.cleanupPlans) ? store.cleanupPlans : []
  };
  await writeFile(plexDuplicateDecisionsPath, JSON.stringify(next, null, 2), "utf8");
  return next;
}

function findPlexDuplicateRow(report, rowId) {
  return asArray(report?.rows).find((row) => row.rowId === rowId) || null;
}

async function setPlexDuplicateDecision(body, remoteAddress) {
  const action = stringValue(body.action || body.decision).toLowerCase();
  if (!["approved", "swapped", "ignored", "clear"].includes(action)) {
    throw new Error("Decision action must be approved, swapped, ignored, or clear.");
  }
  const rowId = stringValue(body.rowId).trim();
  if (!rowId) throw new Error("Missing Plex duplicate rowId.");

  const report = await getPlexDuplicateReport();
  const row = findPlexDuplicateRow(report, rowId);
  if (!row) throw new Error("Plex duplicate row was not found in the latest report.");

  const store = await readPlexDuplicateDecisions();
  if (action === "clear") {
    delete store.decisions[rowId];
  } else {
    store.decisions[rowId] = {
      rowId,
      action,
      reason: stringValue(body.reason || (action === "ignored" ? "keep_both" : action === "swapped" ? "swap_keep_candidate" : "cleanup_candidate")).slice(0, 120),
      note: stringValue(body.note).slice(0, 1000),
      title: row.title,
      reportPath: report.path,
      reportGeneratedAt: report.generatedAt,
      groupFingerprint: row.groupFingerprint,
      pairFingerprint: row.pairFingerprint,
      groupFiles: row.groupFiles,
      keepFiles: row.keepFiles,
      candidateFiles: row.candidateFiles,
      cleanupKeepFiles: action === "swapped" ? row.candidateFiles : row.keepFiles,
      cleanupCandidateFiles: action === "swapped" ? row.keepFiles : row.candidateFiles,
      cleanupMode: action === "swapped" ? "swap" : "candidate",
      confidence: row.confidence,
      updatedAt: new Date().toISOString(),
      remoteAddress
    };
  }
  await writePlexDuplicateDecisions(store);
  await writeCommandLog({
    id: randomUUID().replaceAll("-", ""),
    receivedAt: new Date().toISOString(),
    remoteAddress,
    action: `plex.duplicates.${action}`,
    status: "completed",
    result: {
      rowId,
      title: row.title,
      message: action === "clear" ? "Plex duplicate decision cleared." : `Plex duplicate row marked ${action}.`
    }
  });
  return store.decisions[rowId] || { rowId, action: "clear" };
}

function fileNameFromPath(filePath) {
  return path.basename(stringValue(filePath).replace(/\\/g, "/")) || "media-file";
}

function plexPathToTrueNasPath(filePath) {
  const text = stringValue(filePath);
  if (text.startsWith("/data/")) return `/mnt/Plex/Media/${text.slice("/data/".length)}`;
  return text;
}

function quarantinePathFor(filePath, stamp) {
  const text = plexPathToTrueNasPath(filePath);
  const quarantineRoot = `/mnt/Plex/Media/Quarantine/${stamp}`;
  const prefix = "/mnt/Plex/Media/";
  if (text.startsWith(prefix)) {
    return `${quarantineRoot}/${text.slice(prefix.length)}`;
  }
  return `${quarantineRoot}/${fileNameFromPath(text)}`;
}

function playbackFailedPathFor(filePath, planId) {
  const text = plexPathToTrueNasPath(filePath);
  const failedRoot = `/mnt/Plex/Media/Quarantine/${planId}/PlaybackFailed`;
  const prefix = "/mnt/Plex/Media/";
  if (text.startsWith(prefix)) {
    return `${failedRoot}/${text.slice(prefix.length)}`;
  }
  return `${failedRoot}/${fileNameFromPath(text)}`;
}

function mediaParentFolder(filePath) {
  const text = plexPathToTrueNasPath(filePath).replace(/\\/g, "/");
  return path.posix.dirname(text);
}

function assertPlexMediaPath(filePath, label) {
  const text = plexPathToTrueNasPath(filePath);
  if (!text.startsWith("/mnt/Plex/Media/")) throw new Error(`${label} must be under /mnt/Plex/Media: ${text}`);
  if (/[\0\r\n]/.test(text)) throw new Error(`${label} contains invalid control characters.`);
  if (text.includes("/../") || text.endsWith("/..") || text.includes("/./")) throw new Error(`${label} contains unsafe path traversal.`);
  return text;
}

function approvedPlexDuplicateRows(report, store) {
  return asArray(report?.rows).filter((row) => {
    const decision = store.decisions[row.rowId];
    return ["approved", "swapped"].includes(decision?.action) && decision.groupFingerprint === row.groupFingerprint;
  }).map((row) => {
    const decision = store.decisions[row.rowId];
    const swapped = decision?.action === "swapped";
    return {
      ...row,
      cleanupMode: swapped ? "swap" : "candidate",
      cleanupKeepFiles: swapped ? row.candidateFiles : row.keepFiles,
      cleanupCandidateFiles: swapped ? row.keepFiles : row.candidateFiles
    };
  });
}

function buildPlexCleanupPlanFromRows({ report, rows, body, remoteAddress, status = "preview" }) {
  if (rows.length === 0) {
    throw new Error("No approved Plex duplicate rows match the latest report.");
  }

  const createdAt = new Date().toISOString();
  const stamp = createdAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const planId = `plex-cleanup-plan-${stamp}`;
  const quarantineRoot = `/mnt/Plex/Media/Quarantine/${stamp}`;
  const progressPath = `${quarantineRoot}/.homeops-progress.json`;
  const moves = rows.flatMap((row) => asArray(row.cleanupCandidateFiles || row.candidateFiles).map((file) => ({
    title: row.title,
    rowId: row.rowId,
    cleanupMode: row.cleanupMode || "candidate",
    source: assertPlexMediaPath(file, "source"),
    sourceFolder: assertPlexMediaPath(mediaParentFolder(file), "source folder"),
    quarantine: assertPlexMediaPath(quarantinePathFor(file, stamp), "quarantine"),
    keepFiles: asArray(row.cleanupKeepFiles || row.keepFiles).map((keepFile) => assertPlexMediaPath(keepFile, "keep file")),
    originalKeepFiles: asArray(row.keepFiles),
    originalCandidateFiles: asArray(row.candidateFiles),
    confidence: row.confidence,
    reason: row.reason
  })));
  for (const move of moves) {
    move.verificationKey = verificationKeyForMove(move);
  }

  return {
    planId,
    createdAt,
    createdBy: remoteAddress,
    reportPath: report.path,
    reportGeneratedAt: report.generatedAt,
    quarantineRoot,
    progressPath,
    status,
    safety: "Approved duplicate files are moved to quarantine, Plex is rescanned, playback verification is manual, and final deletion is separately gated.",
    stages: [
      {
        id: "quarantine",
        label: "Move approved files to quarantine",
        status: status === "running" ? "running" : "pending",
        requiresApproval: true,
        confirm: "QUARANTINE",
        note: "Move files only to the listed quarantine paths."
      },
      {
        id: "plex_rescan",
        label: "Run Plex library rescan",
        status: "pending",
        requiresApproval: false,
        note: "Refresh Plex after quarantine so missing media and duplicate state are visible."
      },
      {
        id: "verification",
        label: "Verify Plex metadata and playback",
        status: "pending",
        requiresApproval: false,
        note: "Confirm kept versions play and metadata remains correct."
      },
      {
        id: "final_delete_approval",
        label: "Final approval before deleting quarantined files",
        status: "blocked",
        requiresApproval: true,
        confirm: "DELETE",
        note: "Deletion remains blocked until quarantine, Plex rescan, and playback verification are complete."
      }
    ],
    finalDeleteApproval: null,
    verificationChecks: {},
    nextSteps: [
      "Preview the listed source and quarantine paths.",
      "Submit confirm=QUARANTINE to move the listed candidate files.",
      "Verify Plex metadata and playback for kept versions after rescan.",
      "Record final delete approval later only after verification."
    ],
    approvedRows: rows.length,
    moveCount: moves.length,
    sourceFolders: sortedUnique(moves.map((move) => move.sourceFolder)),
    sourceFolderCleanup: {
      mode: "remove_when_no_movie_files",
      removed: [],
      kept: [],
      skipped: []
    },
    moves,
    note: stringValue(body?.note).slice(0, 1000)
  };
}

function updatePlanStage(plan, stageId, patch) {
  plan.stages = asArray(plan.stages).map((stage) => (
    stage.id === stageId ? { ...stage, ...patch } : stage
  ));
  return plan;
}

function isPlexCleanupPlanOpen(plan) {
  return [
    "running",
    "awaiting_playback_verification",
    "awaiting_final_delete_approval"
  ].includes(stringValue(plan?.status));
}

async function savePlexCleanupPlan(plan) {
  const jsonPath = path.join(reportsRoot, `${plan.planId}.json`);
  const mdPath = path.join(reportsRoot, `${plan.planId}.md`);
  const latestJsonPath = path.join(reportsRoot, "plex-cleanup-plan-latest.json");
  const latestMdPath = path.join(reportsRoot, "plex-cleanup-plan-latest.md");
  const json = JSON.stringify(plan, null, 2);
  const markdown = renderPlexCleanupPlanMarkdown(plan);
  await mkdir(reportsRoot, { recursive: true });
  await writeFile(jsonPath, json, "utf8");
  await writeFile(mdPath, markdown, "utf8");
  await writeFile(latestJsonPath, json, "utf8");
  await writeFile(latestMdPath, markdown, "utf8");
  return { jsonPath, mdPath };
}

function buildPlexQuarantineCommand(moves, progressPath) {
  const payload = Buffer.from(JSON.stringify({
    moves,
    progressPath,
    sourceFolders: sortedUnique(moves.map((move) => move.sourceFolder))
  }), "utf8").toString("base64");
  return `python3 - <<'PY'
import base64
import errno
import json
import os
import shutil
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

payload = json.loads(base64.b64decode("${payload}").decode("utf-8"))
moves = payload["moves"]
progress_path = payload["progressPath"]
source_folders = payload.get("sourceFolders", [])
media_root = "/mnt/Plex/Media"
movie_extensions = {
    ".3g2", ".3gp", ".asf", ".avi", ".divx", ".flv", ".m2ts", ".m4v",
    ".mkv", ".mov", ".mp4", ".mpeg", ".mpg", ".mts", ".ogm", ".ogv",
    ".rm", ".rmvb", ".ts", ".vob", ".webm", ".wmv"
}

def validate(path):
    if not path.startswith("/mnt/Plex/"):
        raise SystemExit("unsafe path outside /mnt/Plex: " + path)
    if "\\x00" in path or "\\n" in path or "\\r" in path:
        raise SystemExit("unsafe control character in path")
    parts = path.split("/")
    if ".." in parts or "." in parts:
        raise SystemExit("unsafe traversal in path: " + path)
    return path

progress_path = validate(progress_path)

def write_progress(status, phase, current, message, move=None):
    os.makedirs(os.path.dirname(progress_path), exist_ok=True)
    tmp_path = progress_path + ".tmp"
    data = {
        "status": status,
        "phase": phase,
        "current": current,
        "total": len(moves),
        "message": message,
        "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    }
    if move:
        data["currentTitle"] = move.get("title", "")
        data["currentSource"] = move.get("source", "")
        data["currentQuarantine"] = move.get("quarantine", "")
    with open(tmp_path, "w", encoding="utf-8") as handle:
        json.dump(data, handle)
    os.replace(tmp_path, progress_path)

def copy_then_unlink(source, quarantine, index, move):
    source_size = os.path.getsize(source)
    copied = 0
    with open(source, "rb") as src, open(quarantine, "wb") as dst:
        while True:
            chunk = src.read(1024 * 1024 * 16)
            if not chunk:
                break
            dst.write(chunk)
            copied += len(chunk)
            if copied == source_size or copied % (1024 * 1024 * 256) < len(chunk):
                write_progress(
                    "running",
                    "moving",
                    index - 1,
                    "Copying file " + str(index) + " of " + str(len(moves)) + ".",
                    move
                )
    copied_size = os.path.getsize(quarantine)
    if copied_size != source_size:
        raise SystemExit("copy size mismatch: " + source + " -> " + quarantine)
    try:
        os.chmod(quarantine, os.stat(source).st_mode & 0o777)
    except PermissionError:
        pass
    os.unlink(source)

def move_media_file(source, quarantine, index, move):
    try:
        os.rename(source, quarantine)
    except OSError as error:
        if error.errno != errno.EXDEV:
            raise
        copy_then_unlink(source, quarantine, index, move)

def has_movie_file(folder):
    for root, dirs, files in os.walk(folder):
        dirs[:] = [name for name in dirs if name not in {"@eaDir", ".recycle", "#recycle"}]
        for name in files:
            if os.path.splitext(name)[1].lower() in movie_extensions:
                return True
    return False

def cleanup_source_folder(folder):
    folder = validate(folder)
    if not folder.startswith(media_root + "/"):
        print("source_folder_skipped_outside_media=" + folder)
        return
    rel_parts = os.path.relpath(folder, media_root).split(os.sep)
    if len(rel_parts) < 2 or rel_parts[0] == "Quarantine":
        print("source_folder_skipped_too_broad=" + folder)
        return
    if not os.path.exists(folder):
        print("source_folder_already_missing=" + folder)
        return
    if has_movie_file(folder):
        print("source_folder_kept_movie_files=" + folder)
        return
    shutil.rmtree(folder)
    print("source_folder_removed_no_movie_files=" + folder)

write_progress("running", "moving", 0, "Starting quarantine moves.")
for index, move in enumerate(moves, start=1):
    source = validate(move["source"])
    quarantine = validate(move["quarantine"])
    write_progress("running", "moving", index - 1, "Moving file " + str(index) + " of " + str(len(moves)) + ".", move)
    if not os.path.exists(source):
        write_progress("failed", "moving", index - 1, "Source missing: " + source, move)
        raise SystemExit("source missing: " + source)
    if os.path.exists(quarantine):
        write_progress("failed", "moving", index - 1, "Quarantine target already exists: " + quarantine, move)
        raise SystemExit("quarantine target already exists: " + quarantine)
    os.makedirs(os.path.dirname(quarantine), exist_ok=True)
    move_media_file(source, quarantine, index, move)
    write_progress("running", "moving", index, "Moved file " + str(index) + " of " + str(len(moves)) + ".", move)
    print("moved=" + source + " -> " + quarantine)

write_progress("running", "folder-cleanup", len(moves), "Checking source folders for empty movie folders.")
for folder in source_folders:
    cleanup_source_folder(folder)

write_progress("running", "rescanning", len(moves), "Quarantine moves complete. Refreshing Plex movie libraries.")
pref = "/mnt/Plex/AppData/PlexServer/PlexConfig/Library/Application Support/Plex Media Server/Preferences.xml"
token = ET.parse(pref).getroot().attrib.get("PlexOnlineToken") or ""
if not token:
    write_progress("failed", "rescanning", len(moves), "Plex token missing.")
    raise SystemExit("Plex token missing")
base = "http://127.0.0.1:32400"
sections_xml = urllib.request.urlopen(base + "/library/sections?" + urllib.parse.urlencode({"X-Plex-Token": token}), timeout=30).read()
sections = ET.fromstring(sections_xml)
refreshed = 0
for section in sections.findall("Directory"):
    if section.attrib.get("type") != "movie":
        continue
    key = section.attrib.get("key")
    urllib.request.urlopen(base + "/library/sections/" + key + "/refresh?" + urllib.parse.urlencode({"X-Plex-Token": token}), timeout=30).read()
    print("plex_refresh_section=" + key + ":" + section.attrib.get("title", "Movies"))
    refreshed += 1
print("plex_refresh_sections=" + str(refreshed))
write_progress("complete", "complete", len(moves), "Quarantine moves complete and Plex rescan requested.")
PY`;
}

function buildPlexDeleteCommand(pathsToDelete) {
  const payload = Buffer.from(JSON.stringify({ paths: pathsToDelete }), "utf8").toString("base64");
  return `python3 - <<'PY'
import base64
import json
import os

payload = json.loads(base64.b64decode("${payload}").decode("utf-8"))
deleted_parent_folders = set()

def validate_quarantine_path(path):
    if not path.startswith("/mnt/Plex/Media/Quarantine/"):
        raise SystemExit("refusing to delete outside quarantine: " + path)
    if "\\x00" in path or "\\n" in path or "\\r" in path:
        raise SystemExit("unsafe control character in path")
    parts = path.split("/")
    if ".." in parts or "." in parts:
        raise SystemExit("unsafe traversal in path: " + path)
    return path

def removable_parent_folders(folder):
    folders = []
    current = folder
    quarantine_root = "/mnt/Plex/Media/Quarantine"
    while current.startswith(quarantine_root + "/") and current != quarantine_root:
        folders.append(current)
        current = os.path.dirname(current)
    return folders

for path in payload["paths"]:
    path = validate_quarantine_path(path)
    if not os.path.exists(path):
        print("already_missing=" + path)
        continue
    if os.path.isdir(path):
        raise SystemExit("refusing to delete directory: " + path)
    deleted_parent_folders.add(os.path.dirname(path))
    os.remove(path)
    print("deleted=" + path)

for folder in sorted({candidate for folder in deleted_parent_folders for candidate in removable_parent_folders(folder)}, key=len, reverse=True):
    folder = validate_quarantine_path(folder)
    if not os.path.exists(folder):
        print("folder_already_missing=" + folder)
        continue
    try:
        os.rmdir(folder)
        print("deleted_folder=" + folder)
    except OSError:
        print("kept_folder_not_empty=" + folder)
PY`;
}

function buildPlexRestoreCommand({ restoreSource, restoreTarget, failedKeepMoves }) {
  const payload = Buffer.from(JSON.stringify({ restoreSource, restoreTarget, failedKeepMoves }), "utf8").toString("base64");
  return `python3 - <<'PY'
import base64
import errno
import filecmp
import json
import os
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

payload = json.loads(base64.b64decode("${payload}").decode("utf-8"))
restore_source = payload["restoreSource"]
restore_target = payload["restoreTarget"]
failed_keep_moves = payload.get("failedKeepMoves", [])

def validate_media(path):
    if not path.startswith("/mnt/Plex/Media/"):
        raise SystemExit("unsafe media path outside /mnt/Plex/Media: " + path)
    if "\\x00" in path or "\\n" in path or "\\r" in path:
        raise SystemExit("unsafe control character in path")
    parts = path.split("/")
    if ".." in parts or "." in parts:
        raise SystemExit("unsafe traversal in path: " + path)
    return path

def validate_quarantine(path):
    path = validate_media(path)
    if not path.startswith("/mnt/Plex/Media/Quarantine/"):
        raise SystemExit("unsafe quarantine path outside quarantine: " + path)
    return path

def move_file(source, target):
    os.makedirs(os.path.dirname(target), exist_ok=True)
    try:
        os.rename(source, target)
    except OSError as error:
        if error.errno != errno.EXDEV:
            raise
        with open(source, "rb") as src, open(target, "wb") as dst:
            while True:
                chunk = src.read(1024 * 1024 * 16)
                if not chunk:
                    break
                dst.write(chunk)
        if os.path.getsize(source) != os.path.getsize(target):
            raise SystemExit("restore copy size mismatch: " + source + " -> " + target)
        os.unlink(source)

restore_source = validate_quarantine(restore_source)
restore_target = validate_media(restore_target)
if not os.path.exists(restore_source):
    raise SystemExit("restore source missing: " + restore_source)

restore_target_already_present = os.path.exists(restore_target)
if restore_target_already_present:
    matched_failed_keep = False
    for move in failed_keep_moves:
        source = validate_media(move["source"])
        if os.path.exists(source) and os.path.isfile(source) and os.path.getsize(source) == os.path.getsize(restore_source):
            if filecmp.cmp(source, restore_source, shallow=False):
                matched_failed_keep = True
                break
    if not matched_failed_keep:
        raise SystemExit("restore target already exists and quarantine source does not match the failed kept file; refusing to overwrite: " + restore_target)
    print("restore_target_already_present=" + restore_target)
    print("restore_source_matches_failed_keep=" + restore_source)

for move in failed_keep_moves:
    source = validate_media(move["source"])
    quarantine = validate_quarantine(move["quarantine"])
    if not os.path.exists(source):
        print("failed_keep_already_missing=" + source)
        continue
    if os.path.exists(quarantine):
        if restore_target_already_present and filecmp.cmp(source, quarantine, shallow=False):
            print("failed_keep_quarantine_already_present=" + quarantine)
            continue
        raise SystemExit("failed keep quarantine target already exists: " + quarantine)
    move_file(source, quarantine)
    print("failed_keep_quarantined=" + source + " -> " + quarantine)

if restore_target_already_present:
    print("restore_source_left_for_final_delete=" + restore_source)
else:
    move_file(restore_source, restore_target)
    print("restored=" + restore_source + " -> " + restore_target)

pref = "/mnt/Plex/AppData/PlexServer/PlexConfig/Library/Application Support/Plex Media Server/Preferences.xml"
token = ET.parse(pref).getroot().attrib.get("PlexOnlineToken") or ""
if not token:
    raise SystemExit("Plex token missing")
base = "http://127.0.0.1:32400"
sections_xml = urllib.request.urlopen(base + "/library/sections?" + urllib.parse.urlencode({"X-Plex-Token": token}), timeout=30).read()
sections = ET.fromstring(sections_xml)
refreshed = 0
for section in sections.findall("Directory"):
    if section.attrib.get("type") != "movie":
        continue
    key = section.attrib.get("key")
    urllib.request.urlopen(base + "/library/sections/" + key + "/refresh?" + urllib.parse.urlencode({"X-Plex-Token": token}), timeout=30).read()
    print("plex_refresh_section=" + key + ":" + section.attrib.get("title", "Movies"))
    refreshed += 1
print("plex_refresh_sections=" + str(refreshed))
PY`;
}

function buildPlexLibraryRescanCommand() {
  return `python3 - <<'PY'
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

pref = "/mnt/Plex/AppData/PlexServer/PlexConfig/Library/Application Support/Plex Media Server/Preferences.xml"
token = ET.parse(pref).getroot().attrib.get("PlexOnlineToken") or ""
if not token:
    raise SystemExit("Plex token missing")
base = "http://127.0.0.1:32400"
sections_xml = urllib.request.urlopen(base + "/library/sections?" + urllib.parse.urlencode({"X-Plex-Token": token}), timeout=30).read()
sections = ET.fromstring(sections_xml)
refreshed = 0
for section in sections.findall("Directory"):
    if section.attrib.get("type") != "movie":
        continue
    key = section.attrib.get("key")
    urllib.request.urlopen(base + "/library/sections/" + key + "/refresh?" + urllib.parse.urlencode({"X-Plex-Token": token}), timeout=30).read()
    print("plex_refresh_section=" + key + ":" + section.attrib.get("title", "Movies"))
    refreshed += 1
print("plex_refresh_sections=" + str(refreshed))
PY`;
}

function parsePlexSourceFolderCleanup(commandOutput) {
  const result = {
    mode: "remove_when_no_movie_files",
    removed: [],
    kept: [],
    skipped: [],
    alreadyMissing: []
  };
  for (const line of stringValue(commandOutput).split(/\r?\n/)) {
    const [key, ...rest] = line.split("=");
    const value = rest.join("=").trim();
    if (!value) continue;
    if (key === "source_folder_removed_no_movie_files") result.removed.push(value);
    if (key === "source_folder_kept_movie_files") result.kept.push(value);
    if (key === "source_folder_already_missing") result.alreadyMissing.push(value);
    if (key.startsWith("source_folder_skipped_")) result.skipped.push(value);
  }
  return result;
}

function parsePlexFinalDeleteSummary(commandOutput, plan = null) {
  const deletedFiles = [];
  const alreadyMissingFiles = [];
  const deletedFolders = [];
  const keptFolders = [];
  const alreadyMissingFolders = [];
  for (const line of stringValue(commandOutput).split(/\r?\n/)) {
    const [key, ...rest] = line.split("=");
    const value = rest.join("=").trim();
    if (!value) continue;
    if (key === "deleted") deletedFiles.push(value);
    if (key === "already_missing") alreadyMissingFiles.push(value);
    if (key === "deleted_folder") deletedFolders.push(value);
    if (key === "kept_folder_not_empty") keptFolders.push(value);
    if (key === "folder_already_missing") alreadyMissingFolders.push(value);
  }

  const titleByDeletePath = new Map();
  for (const move of asArray(plan?.moves)) {
    const restoreAction = move.restoreAction || {};
    if (restoreAction.restored) {
      for (const file of asArray(restoreAction.failedKeepQuarantineFiles)) {
        titleByDeletePath.set(file, move.title || "");
      }
    } else {
      titleByDeletePath.set(move.quarantine, move.title || "");
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    deletedFileCount: deletedFiles.length,
    alreadyMissingFileCount: alreadyMissingFiles.length,
    deletedFolderCount: deletedFolders.length,
    keptFolderCount: keptFolders.length,
    deletedFiles: deletedFiles.map((file) => ({
      title: titleByDeletePath.get(file) || "",
      file,
      folder: mediaParentFolder(file)
    })),
    alreadyMissingFiles,
    deletedFolders,
    keptFolders,
    alreadyMissingFolders
  };
}

function finalDeletePathsForPlan(plan) {
  const paths = [];
  for (const move of asArray(plan.moves)) {
    const restoreAction = move.restoreAction || {};
    if (restoreAction.restored) {
      paths.push(...asArray(restoreAction.failedKeepQuarantineFiles));
      paths.push(...asArray(restoreAction.redundantQuarantineFiles));
    } else {
      paths.push(move.quarantine);
    }
  }
  return sortedUnique(paths).map((target) => assertQuarantinePath(target, "quarantine delete target"));
}

async function runTrueNasCommand(command, description, timeoutSec = 900) {
  const commandFile = path.join(homeOpsRoot, "logs", `truenas-homeops-command-${randomUUID()}.sh`);
  await mkdir(path.dirname(commandFile), { recursive: true });
  await writeFile(commandFile, command, "utf8");
  return await runNodeScript("Invoke-TrueNasCronCommand.js", [
    "--description", description,
    "--timeout-sec", String(timeoutSec),
    "--command-file", commandFile
  ], (timeoutSec + 60) * 1000);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function decryptTrueNasApiKey() {
  const apiKeyPath = path.join(homeOpsRoot, "config", "truenas.codex.api-key.xml");
  const script = `
function ConvertFrom-SecureStringPlainText([securestring]$s) {
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}
ConvertFrom-SecureStringPlainText (Import-Clixml -LiteralPath '${apiKeyPath.replace(/'/g, "''")}')
`;
  return await new Promise((resolve, reject) => {
    const child = spawn(powershellPath, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
      cwd: homeOpsRoot,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || "Failed to decrypt TrueNAS API key."));
        return;
      }
      const key = stdout.trim();
      if (!key) reject(new Error("TrueNAS API key file decrypted to an empty value."));
      else resolve(key);
    });
  });
}

async function connectTrueNasApi() {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  const ws = new WebSocket("wss://192.168.1.34/api/current", { headers: { Origin: "https://192.168.1.34" } });
  let nextId = 1;
  const pending = new Map();

  function call(method, params = []) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject, method });
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const pendingCall = pending.get(message.id);
    if (!pendingCall) return;
    pending.delete(message.id);
    if (message.error) pendingCall.reject(new Error(`${pendingCall.method}: ${JSON.stringify(message.error)}`));
    else pendingCall.resolve(message.result);
  };

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out connecting to TrueNAS WSS API.")), 15000);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("Failed to connect to TrueNAS WSS API."));
    };
  });

  const apiKey = await decryptTrueNasApiKey();
  if (!(await call("auth.login_with_api_key", [apiKey]))) {
    throw new Error("TrueNAS API key authentication failed.");
  }
  return { ws, call };
}

async function waitTrueNasJob(call, jobId, timeoutSec = 60) {
  for (let i = 0; i < timeoutSec; i += 1) {
    const jobs = await call("core.get_jobs", [[["id", "=", jobId]], { extra: { raw_result: true } }]);
    const job = jobs[0];
    if (job && ["SUCCESS", "FAILED", "ABORTED"].includes(job.state)) {
      if (job.state !== "SUCCESS") throw new Error(`TrueNAS job ${jobId} ${job.state}: ${job.error || job.exception || "no error text"}`);
      return job;
    }
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for TrueNAS job ${jobId}.`);
}

async function readTrueNasText(remotePath) {
  const { ws, call } = await connectTrueNasApi();
  try {
    const [jobId, url] = await call("core.download", ["filesystem.get", [remotePath], path.basename(remotePath), true]);
    const response = await fetch(`https://192.168.1.34${url}`);
    if (!response.ok) throw new Error(`TrueNAS download failed with HTTP ${response.status}.`);
    const text = await response.text();
    await waitTrueNasJob(call, jobId, 60);
    return text;
  } finally {
    ws.close();
  }
}

async function countTrueNasFiles(remoteRoot) {
  const { ws, call } = await connectTrueNasApi();
  try {
    const stack = [remoteRoot];
    let count = 0;
    while (stack.length) {
      const current = stack.pop();
      const entries = await call("filesystem.listdir", [current]);
      for (const entry of entries) {
        if (entry.type === "DIRECTORY") stack.push(entry.path);
        else if (entry.type === "FILE" && entry.name !== ".homeops-progress.json") count += 1;
      }
    }
    return count;
  } finally {
    ws.close();
  }
}

function getPlanQuarantineRoot(plan) {
  const explicit = stringValue(plan?.quarantineRoot);
  if (explicit) return explicit;
  const firstQuarantine = stringValue(asArray(plan?.moves)[0]?.quarantine);
  const match = firstQuarantine.match(/^(\/mnt\/Plex\/Media\/Quarantine\/[^/]+)/);
  return match ? match[1] : "";
}

function verificationKeyForMove(move) {
  const text = [
    stringValue(move?.rowId),
    stringValue(move?.source),
    stringValue(move?.quarantine)
  ].join("|");
  return createHash("sha256").update(text).digest("hex").slice(0, 24);
}

function getVerificationChecks(plan) {
  return plan && typeof plan.verificationChecks === "object" && plan.verificationChecks !== null
    ? plan.verificationChecks
    : {};
}

function verificationItemsForPlan(plan) {
  const checks = getVerificationChecks(plan);
  return asArray(plan?.moves).map((move) => {
    const key = move.verificationKey || verificationKeyForMove(move);
    const check = checks[key] || {};
    const status = check.restored ? "restored" : check.issue ? "issue" : check.verified ? "verified" : "pending";
    return {
      key,
      title: move.title || "",
      keepFiles: asArray(move.keepFiles),
      quarantinedFile: move.quarantine || "",
      sourceFile: move.source || "",
      cleanupMode: move.cleanupMode || "candidate",
      status,
      verified: Boolean(check.verified),
      verifiedAt: check.verifiedAt || "",
      verifiedBy: check.verifiedBy || "",
      issue: Boolean(check.issue),
      issueNote: check.issueNote || "",
      issueAt: check.issueAt || "",
      restored: Boolean(check.restored),
      restoredAt: check.restoredAt || "",
      failedKeepQuarantineFiles: asArray(check.failedKeepQuarantineFiles || move.restoreAction?.failedKeepQuarantineFiles)
    };
  });
}

function verificationSummaryForPlan(plan) {
  const items = verificationItemsForPlan(plan);
  const verifiedCount = items.filter((item) => item.status === "verified").length;
  const issueCount = items.filter((item) => item.status === "issue").length;
  const restoredCount = items.filter((item) => item.status === "restored").length;
  const resolvedCount = verifiedCount + issueCount + restoredCount;
  return {
    total: items.length,
    verified: verifiedCount,
    issues: issueCount,
    restored: restoredCount,
    resolved: resolvedCount,
    remaining: Math.max(0, items.length - resolvedCount),
    complete: items.length > 0 && resolvedCount === items.length
  };
}

function pendingRestoreMovesForPlan(plan) {
  const checks = getVerificationChecks(plan);
  return asArray(plan?.moves).filter((move) => {
    const key = move.verificationKey || verificationKeyForMove(move);
    const check = checks[key] || {};
    return Boolean(check.issue) && !check.restored && !move.restoreAction?.restored;
  });
}

async function applyPlexRestoreForMove(plan, move, remoteAddress, note, restoredAt = new Date().toISOString()) {
  const key = move.verificationKey || verificationKeyForMove(move);
  if (move.restoreAction?.restored) {
    return {
      title: move.title,
      key,
      skipped: true,
      reason: "already restored",
      failedKeepQuarantineFiles: asArray(move.restoreAction.failedKeepQuarantineFiles)
    };
  }

  const failedKeepMoves = asArray(move.keepFiles).map((file) => ({
    source: assertPlexMediaPath(file, "failed keep source"),
    quarantine: assertQuarantinePath(playbackFailedPathFor(file, plan.planId), "failed keep quarantine")
  }));
  const failedKeepQuarantineFiles = failedKeepMoves.map((failedMove) => failedMove.quarantine);
  const issueNote = stringValue(note || "Playback failed; restored quarantined duplicate.").slice(0, 1000);

  move.restoreResult = await runTrueNasCommand(buildPlexRestoreCommand({
    restoreSource: assertQuarantinePath(move.quarantine, "restore source"),
    restoreTarget: assertPlexMediaPath(move.source, "restore target"),
    failedKeepMoves
  }), `homeops plex duplicate restore ${plan.planId}`, 21600);
  const restoreOutput = stringValue(move.restoreResult?.output);
  const targetAlreadyPresent = restoreOutput.includes("restore_target_already_present=");
  const redundantQuarantineFiles = targetAlreadyPresent ? [move.quarantine] : [];
  move.restoreAction = {
    restored: true,
    restoredAt,
    restoredBy: remoteAddress,
    issueNote,
    targetAlreadyPresent,
    restoredFrom: move.quarantine,
    restoredTo: move.source,
    failedKeepFiles: asArray(move.keepFiles),
    failedKeepQuarantineFiles,
    redundantQuarantineFiles,
    approvalMeaning: targetAlreadyPresent
      ? "The restore target was already present, so the failed kept file(s) were moved into quarantine and redundant quarantined copies were approved for final deletion."
      : "Restored the quarantined duplicate for this item and moved the failed kept file(s) into quarantine."
  };

  plan.verificationChecks = getVerificationChecks(plan);
  plan.verificationChecks[key] = {
    ...(plan.verificationChecks[key] || {}),
    issue: true,
    issueNote,
    issueAt: plan.verificationChecks[key]?.issueAt || restoredAt,
    issueBy: plan.verificationChecks[key]?.issueBy || remoteAddress,
    restored: true,
    restoredAt,
    restoredBy: remoteAddress,
    failedKeepQuarantineFiles,
    redundantQuarantineFiles,
    verified: true,
    verifiedAt: restoredAt,
    verifiedBy: remoteAddress
  };

  return {
    title: move.title,
    key,
    targetAlreadyPresent,
    restoredFrom: move.quarantine,
    restoredTo: move.source,
    failedKeepQuarantineFiles,
    redundantQuarantineFiles
  };
}

function assertQuarantinePath(filePath, label) {
  const text = stringValue(filePath);
  if (!text.startsWith("/mnt/Plex/Media/Quarantine/")) throw new Error(`${label} must be under /mnt/Plex/Media/Quarantine: ${text}`);
  if (/[\0\r\n]/.test(text)) throw new Error(`${label} contains invalid control characters.`);
  if (text.includes("/../") || text.endsWith("/..") || text.includes("/./")) throw new Error(`${label} contains unsafe path traversal.`);
  return text;
}

async function readPlexCleanupPlanFile(planPath) {
  const plan = JSON.parse(stripBom(await readFile(planPath, "utf8")));
  plan.__jsonPath = planPath;
  return plan;
}

async function getPlexCleanupPlanDocuments() {
  if (!existsSync(reportsRoot)) return [];
  const files = await readdir(reportsRoot);
  const plans = [];
  for (const file of files) {
    if (!/^plex-cleanup-plan-\d{8}T\d{6}Z\.json$/.test(file)) continue;
    try {
      plans.push(await readPlexCleanupPlanFile(path.join(reportsRoot, file)));
    } catch {
      // Ignore malformed historical plan files.
    }
  }
  return plans.sort((a, b) => stringValue(b.createdAt).localeCompare(stringValue(a.createdAt)));
}

async function getCurrentPlexCleanupPlanDocument() {
  const active = (await getPlexCleanupPlanDocuments()).find((plan) => plan.status === "running");
  if (active) return active;
  const planPath = path.join(reportsRoot, "plex-cleanup-plan-latest.json");
  if (!existsSync(planPath)) return null;
  return await readPlexCleanupPlanFile(planPath);
}

function progressFromPlan(plan) {
  const stages = asArray(plan?.stages);
  const stage = stages.find((item) => item.status === "running")
    || stages.find((item) => item.status === "failed")
    || stages.find((item) => item.status === "pending");
  const total = Number(plan?.moveCount || asArray(plan?.moves).length || 0);
  return {
    planId: plan?.planId || "",
    status: plan?.status || "",
    phase: stage?.id || plan?.status || "unknown",
    message: stage?.label || plan?.status || "",
    current: 0,
    total,
    percent: total > 0 ? 0 : null,
    updatedAt: new Date().toISOString(),
    stages
  };
}

function progressLooksFresh(progress, maxAgeMs = 30 * 60 * 1000) {
  const updatedAt = Date.parse(stringValue(progress?.updatedAt));
  if (!Number.isFinite(updatedAt)) return false;
  return Date.now() - updatedAt <= maxAgeMs;
}

async function reconcilePlexCleanupPlanWithProgress(plan, progress) {
  if (!plan?.planId || !progress?.status) return plan;
  let changed = false;
  const now = new Date().toISOString();
  const progressStatus = stringValue(progress.status);

  if (progressStatus === "running" && progressLooksFresh(progress)) {
    if (plan.status !== "running") {
      plan.status = "running";
      plan.error = undefined;
      changed = true;
    }
    const before = JSON.stringify(plan.stages || []);
    updatePlanStage(plan, "quarantine", { status: "running", error: undefined });
    updatePlanStage(plan, "plex_rescan", { status: "pending", error: undefined });
    updatePlanStage(plan, "verification", { status: "pending", error: undefined });
    updatePlanStage(plan, "final_delete_approval", { status: "blocked", error: undefined });
    changed = changed || before !== JSON.stringify(plan.stages || []);
  } else if (progressStatus === "complete") {
    if (plan.status !== "awaiting_playback_verification") {
      plan.status = "awaiting_playback_verification";
      plan.error = undefined;
      changed = true;
    }
    const before = JSON.stringify(plan.stages || []);
    updatePlanStage(plan, "quarantine", { status: "complete", completedAt: progress.updatedAt || now, error: undefined });
    updatePlanStage(plan, "plex_rescan", { status: "complete", completedAt: progress.updatedAt || now, error: undefined });
    updatePlanStage(plan, "verification", { status: "pending", error: undefined });
    updatePlanStage(plan, "final_delete_approval", { status: "blocked", error: undefined });
    changed = changed || before !== JSON.stringify(plan.stages || []);
  } else if (progressStatus === "failed") {
    const message = stringValue(progress.message || "Plex cleanup progress reported failure.");
    if (plan.status !== "failed" || plan.error !== message) {
      plan.status = "failed";
      plan.error = message;
      updatePlanStage(plan, "quarantine", { status: "failed", error: message });
      updatePlanStage(plan, "plex_rescan", { status: "blocked" });
      updatePlanStage(plan, "verification", { status: "blocked" });
      updatePlanStage(plan, "final_delete_approval", { status: "blocked" });
      changed = true;
    }
  }

  if (changed) await savePlexCleanupPlan(plan);
  return plan;
}

async function getPlexDuplicateCleanupProgress() {
  const plan = await getCurrentPlexCleanupPlanDocument();
  if (!plan) return null;
  const progress = progressFromPlan(plan);
  const progressPath = stringValue(plan.progressPath);

  if (progressPath) {
    try {
      const remotePath = assertQuarantinePath(progressPath, "progress path");
      const text = stringValue(await readTrueNasText(remotePath)).trim();
      if (text) {
        Object.assign(progress, JSON.parse(text));
        await reconcilePlexCleanupPlanWithProgress(plan, progress);
        progress.stages = plan.stages;
      }
    } catch (error) {
      progress.progressError = error.message;
    }
  }

  const total = Number(progress.total || plan.moveCount || asArray(plan.moves).length || 0);
  if (plan.status === "running" && ["moving", "quarantine"].includes(progress.phase)) {
    try {
      const quarantineRoot = assertQuarantinePath(getPlanQuarantineRoot(plan), "quarantine root");
      const count = await countTrueNasFiles(quarantineRoot);
      if (Number.isFinite(count)) progress.current = Math.max(Number(progress.current || 0), Math.min(count, total));
    } catch (error) {
      progress.countError = error.message;
    }
  }

  progress.total = total;
  progress.percent = total > 0 ? Math.round((Number(progress.current || 0) / total) * 100) : null;
  progress.quarantineRoot = getPlanQuarantineRoot(plan);
  return progress;
}

async function getLatestPlexCleanupPlan() {
  try {
    const plan = await getCurrentPlexCleanupPlanDocument();
    if (!plan) return null;
    return {
      planId: plan.planId || "",
      createdAt: plan.createdAt || "",
      status: plan.status || "",
      approvedRows: plan.approvedRows || 0,
      moveCount: plan.moveCount || 0,
      quarantineRoot: plan.quarantineRoot || getPlanQuarantineRoot(plan),
      progressPath: plan.progressPath || "",
      sourceFolders: asArray(plan.sourceFolders).length
        ? asArray(plan.sourceFolders)
        : sortedUnique(asArray(plan.moves).map((move) => move.sourceFolder || mediaParentFolder(move.source)).filter(Boolean)),
      sourceFolderCleanup: plan.sourceFolderCleanup || null,
      finalDeleteSummary: plan.finalDeleteSummary || (plan.deleteResult?.output ? parsePlexFinalDeleteSummary(plan.deleteResult.output, plan) : null),
      stages: plan.stages || [],
      finalDeleteApproval: plan.finalDeleteApproval || null,
      verificationSummary: verificationSummaryForPlan(plan),
      verificationItems: verificationItemsForPlan(plan),
      jsonPath: plan.__jsonPath || path.join(reportsRoot, "plex-cleanup-plan-latest.json"),
      mdPath: plan.__jsonPath ? plan.__jsonPath.replace(/\.json$/i, ".md") : path.join(reportsRoot, "plex-cleanup-plan-latest.md")
    };
  } catch (error) {
    return { path: path.join(reportsRoot, "plex-cleanup-plan-latest.json"), error: error.message };
  }
}

async function previewPlexDuplicateCleanupPlan(body, remoteAddress) {
  const activePlan = (await getPlexCleanupPlanDocuments()).find(isPlexCleanupPlanOpen);
  if (activePlan) {
    throw new Error(`A Plex cleanup plan is still open: ${activePlan.planId} (${activePlan.status}). Finish verification/final delete or resolve it before previewing another quarantine.`);
  }

  const report = await getPlexDuplicateReport();
  if (!report?.path) throw new Error("No Plex duplicate report is available.");
  const store = await readPlexDuplicateDecisions();
  const rows = approvedPlexDuplicateRows(report, store);
  return buildPlexCleanupPlanFromRows({ report, rows, body, remoteAddress, status: "preview" });
}

async function finalizePlexDuplicateCleanupPlan(body, remoteAddress) {
  if (stringValue(body.confirm) !== "QUARANTINE") {
    throw new Error("Quarantine requires confirm=QUARANTINE.");
  }
  assertMutatingActionsAllowed("Plex duplicate quarantine");

  const activePlan = (await getPlexCleanupPlanDocuments()).find(isPlexCleanupPlanOpen);
  if (activePlan) {
    throw new Error(`A Plex cleanup plan is still open: ${activePlan.planId} (${activePlan.status}). Finish verification/final delete or resolve it before starting another quarantine.`);
  }

  const report = await getPlexDuplicateReport();
  if (!report?.path) throw new Error("No Plex duplicate report is available.");
  const store = await readPlexDuplicateDecisions();
  const rows = approvedPlexDuplicateRows(report, store);
  const plan = buildPlexCleanupPlanFromRows({ report, rows, body, remoteAddress, status: "running" });
  const { createdAt, planId, progressPath, moves } = plan;

  let saved = await savePlexCleanupPlan(plan);
  try {
    plan.quarantineResult = await runTrueNasCommand(buildPlexQuarantineCommand(moves, progressPath), `homeops plex duplicate quarantine ${planId}`, 21600);
    plan.sourceFolderCleanup = parsePlexSourceFolderCleanup(plan.quarantineResult);
    updatePlanStage(plan, "quarantine", { status: "complete", completedAt: new Date().toISOString() });
    updatePlanStage(plan, "plex_rescan", { status: "complete", completedAt: new Date().toISOString() });
    updatePlanStage(plan, "verification", { status: "pending" });
    updatePlanStage(plan, "final_delete_approval", { status: "blocked" });
    plan.status = "awaiting_playback_verification";
  } catch (error) {
    plan.status = "failed";
    plan.error = error.message;
    updatePlanStage(plan, "quarantine", { status: "failed", error: error.message });
    updatePlanStage(plan, "plex_rescan", { status: "blocked" });
    updatePlanStage(plan, "verification", { status: "blocked" });
    updatePlanStage(plan, "final_delete_approval", { status: "blocked" });
  }
  saved = await savePlexCleanupPlan(plan);

  store.cleanupPlans.push({
    planId,
    createdAt,
    reportPath: report.path,
    jsonPath: saved.jsonPath,
    mdPath: saved.mdPath,
    approvedRows: rows.length,
    moveCount: moves.length,
    status: plan.status
  });
  await writePlexDuplicateDecisions(store);
  await writeCommandLog({
    id: randomUUID().replaceAll("-", ""),
    receivedAt: createdAt,
    remoteAddress,
    action: "plex.duplicates.finalize-cleanup-plan",
    status: "completed",
    result: {
      message: plan.status === "failed"
        ? "Plex duplicate cleanup plan failed during quarantine/rescan."
        : "Plex duplicate cleanup plan created, approved files moved to quarantine, and Plex rescan requested.",
      planId,
      jsonPath: saved.jsonPath,
      mdPath: saved.mdPath,
      approvedRows: rows.length,
      moveCount: moves.length,
      status: plan.status
    }
  });
  if (plan.status === "failed") throw new Error(plan.error || "Plex cleanup plan failed.");
  return { ...plan, jsonPath: saved.jsonPath, mdPath: saved.mdPath };
}

async function markPlexCleanupVerificationComplete(body, remoteAddress) {
  const planPath = path.join(reportsRoot, "plex-cleanup-plan-latest.json");
  if (!existsSync(planPath)) throw new Error("No Plex cleanup plan is available.");
  const plan = JSON.parse(stripBom(await readFile(planPath, "utf8")));
  const requestedPlanId = stringValue(body.planId || plan.planId);
  if (requestedPlanId !== stringValue(plan.planId)) {
    throw new Error("Verification planId does not match the latest cleanup plan.");
  }
  const quarantine = asArray(plan.stages).find((stage) => stage.id === "quarantine");
  const plexRescan = asArray(plan.stages).find((stage) => stage.id === "plex_rescan");
  if (quarantine?.status !== "complete" || plexRescan?.status !== "complete") {
    throw new Error("Playback verification cannot be completed until quarantine and Plex rescan are complete.");
  }
  const verificationSummary = verificationSummaryForPlan(plan);
  if (!verificationSummary.complete) {
    throw new Error(`Playback verification requires every movie to be resolved first: ${verificationSummary.resolved} of ${verificationSummary.total} resolved, ${verificationSummary.issues} with open issues.`);
  }
  const completedAt = new Date().toISOString();
  updatePlanStage(plan, "verification", {
    status: "complete",
    completedAt,
    completedBy: remoteAddress,
    note: stringValue(body.note).slice(0, 1000)
  });
  updatePlanStage(plan, "final_delete_approval", { status: "pending" });
  plan.status = "awaiting_final_delete_approval";
  const saved = await savePlexCleanupPlan(plan);
  await writeCommandLog({
    id: randomUUID().replaceAll("-", ""),
    receivedAt: completedAt,
    remoteAddress,
    action: "plex.duplicates.playback-verification-complete",
    status: "completed",
    result: {
      message: "Playback verification marked complete. Final delete approval is now available.",
      planId: plan.planId,
      jsonPath: saved.jsonPath,
      mdPath: saved.mdPath
    }
  });
  return { ...plan, jsonPath: saved.jsonPath, mdPath: saved.mdPath };
}

async function setPlexCleanupVerificationItem(body, remoteAddress) {
  const planPath = path.join(reportsRoot, "plex-cleanup-plan-latest.json");
  if (!existsSync(planPath)) throw new Error("No Plex cleanup plan is available.");
  const plan = JSON.parse(stripBom(await readFile(planPath, "utf8")));
  const requestedPlanId = stringValue(body.planId || plan.planId);
  if (requestedPlanId !== stringValue(plan.planId)) {
    throw new Error("Verification item planId does not match the latest cleanup plan.");
  }
  const quarantine = asArray(plan.stages).find((stage) => stage.id === "quarantine");
  const plexRescan = asArray(plan.stages).find((stage) => stage.id === "plex_rescan");
  if (quarantine?.status !== "complete" || plexRescan?.status !== "complete") {
    throw new Error("Movie playback checks are available after quarantine and Plex rescan are complete.");
  }
  if (plan.finalDeleteApproval) {
    throw new Error("Verification items cannot be changed after final delete approval.");
  }

  const key = stringValue(body.key || body.verificationKey);
  const item = verificationItemsForPlan(plan).find((candidate) => candidate.key === key);
  if (!item) throw new Error("Verification item was not found in this cleanup plan.");

  const verified = body.verified !== false;
  const updatedAt = new Date().toISOString();
  plan.verificationChecks = getVerificationChecks(plan);
  if (verified) {
    plan.verificationChecks[key] = {
      verified: true,
      verifiedAt: updatedAt,
      verifiedBy: remoteAddress
    };
  } else {
    delete plan.verificationChecks[key];
  }
  const summary = verificationSummaryForPlan(plan);
  updatePlanStage(plan, "verification", {
    status: "pending",
    checkedItems: summary.resolved,
    issueItems: summary.issues,
    totalItems: summary.total
  });
  const saved = await savePlexCleanupPlan(plan);
  await writeCommandLog({
    id: randomUUID().replaceAll("-", ""),
    receivedAt: updatedAt,
    remoteAddress,
    action: verified ? "plex.duplicates.playback-item-verified" : "plex.duplicates.playback-item-unverified",
    status: "completed",
    result: {
      message: verified ? "Playback item marked verified." : "Playback item verification cleared.",
      planId: plan.planId,
      title: item.title,
      verifiedItems: summary.verified,
      resolvedItems: summary.resolved,
      totalItems: summary.total,
      jsonPath: saved.jsonPath,
      mdPath: saved.mdPath
    }
  });
  return { ...plan, jsonPath: saved.jsonPath, mdPath: saved.mdPath };
}

async function setPlexCleanupVerificationIssue(body, remoteAddress) {
  const planPath = path.join(reportsRoot, "plex-cleanup-plan-latest.json");
  if (!existsSync(planPath)) throw new Error("No Plex cleanup plan is available.");
  const plan = JSON.parse(stripBom(await readFile(planPath, "utf8")));
  const requestedPlanId = stringValue(body.planId || plan.planId);
  if (requestedPlanId !== stringValue(plan.planId)) {
    throw new Error("Verification issue planId does not match the latest cleanup plan.");
  }
  if (plan.finalDeleteApproval) {
    throw new Error("Verification issues cannot be changed after final delete approval.");
  }

  const key = stringValue(body.key || body.verificationKey);
  const item = verificationItemsForPlan(plan).find((candidate) => candidate.key === key);
  if (!item) throw new Error("Verification item was not found in this cleanup plan.");

  const issue = body.issue !== false;
  const updatedAt = new Date().toISOString();
  plan.verificationChecks = getVerificationChecks(plan);
  if (issue) {
    plan.verificationChecks[key] = {
      issue: true,
      issueNote: stringValue(body.note || body.issueNote || "Playback issue").slice(0, 1000),
      issueAt: updatedAt,
      issueBy: remoteAddress
    };
  } else {
    delete plan.verificationChecks[key];
  }
  const summary = verificationSummaryForPlan(plan);
  updatePlanStage(plan, "verification", {
    status: "pending",
    checkedItems: summary.resolved,
    issueItems: summary.issues,
    totalItems: summary.total
  });
  const saved = await savePlexCleanupPlan(plan);
  await writeCommandLog({
    id: randomUUID().replaceAll("-", ""),
    receivedAt: updatedAt,
    remoteAddress,
    action: issue ? "plex.duplicates.playback-item-issue" : "plex.duplicates.playback-item-issue-cleared",
    status: "completed",
    result: {
      message: issue ? "Playback issue recorded." : "Playback issue cleared.",
      planId: plan.planId,
      title: item.title,
      issueItems: summary.issues,
      resolvedItems: summary.resolved,
      totalItems: summary.total,
      jsonPath: saved.jsonPath,
      mdPath: saved.mdPath
    }
  });
  return { ...plan, jsonPath: saved.jsonPath, mdPath: saved.mdPath };
}

async function restorePlexCleanupVerificationItem(body, remoteAddress) {
  const planPath = path.join(reportsRoot, "plex-cleanup-plan-latest.json");
  if (!existsSync(planPath)) throw new Error("No Plex cleanup plan is available.");
  if (stringValue(body.confirm) !== "RESTORE") {
    throw new Error("Playback restore requires confirm=RESTORE.");
  }
  assertMutatingActionsAllowed("Plex duplicate restore");

  const plan = JSON.parse(stripBom(await readFile(planPath, "utf8")));
  const requestedPlanId = stringValue(body.planId || plan.planId);
  if (requestedPlanId !== stringValue(plan.planId)) {
    throw new Error("Playback restore planId does not match the latest cleanup plan.");
  }
  if (plan.finalDeleteApproval) {
    throw new Error("Playback restore cannot run after final delete approval.");
  }
  const quarantine = asArray(plan.stages).find((stage) => stage.id === "quarantine");
  const plexRescan = asArray(plan.stages).find((stage) => stage.id === "plex_rescan");
  if (quarantine?.status !== "complete" || plexRescan?.status !== "complete") {
    throw new Error("Playback restore is available after quarantine and Plex rescan are complete.");
  }

  const key = stringValue(body.key || body.verificationKey);
  const move = asArray(plan.moves).find((candidate) => (candidate.verificationKey || verificationKeyForMove(candidate)) === key);
  if (!move) throw new Error("Verification item was not found in this cleanup plan.");

  const restoredAt = new Date().toISOString();
  const restore = await applyPlexRestoreForMove(
    plan,
    move,
    remoteAddress,
    body.note || body.issueNote || "Playback failed; restored quarantined duplicate.",
    restoredAt
  );

  const summary = verificationSummaryForPlan(plan);
  updatePlanStage(plan, "verification", {
    status: "pending",
    checkedItems: summary.resolved,
    restoredItems: summary.restored,
    issueItems: summary.issues,
    totalItems: summary.total
  });
  const saved = await savePlexCleanupPlan(plan);
  await writeCommandLog({
    id: randomUUID().replaceAll("-", ""),
    receivedAt: restoredAt,
    remoteAddress,
    action: "plex.duplicates.playback-item-restored",
    status: "completed",
    result: {
      message: "Quarantined duplicate restored and failed kept file moved to quarantine.",
      planId: plan.planId,
      title: move.title,
      restoredFrom: restore.restoredFrom,
      restoredTo: restore.restoredTo,
      failedKeepQuarantineFiles: restore.failedKeepQuarantineFiles,
      resolvedItems: summary.resolved,
      totalItems: summary.total,
      jsonPath: saved.jsonPath,
      mdPath: saved.mdPath
    }
  });
  return { ...plan, jsonPath: saved.jsonPath, mdPath: saved.mdPath };
}

async function recordPlexFinalDeleteApproval(body, remoteAddress) {
  const planPath = path.join(reportsRoot, "plex-cleanup-plan-latest.json");
  if (!existsSync(planPath)) throw new Error("No Plex cleanup plan is available.");
  if (stringValue(body.confirm) !== "DELETE") {
    throw new Error("Final delete approval requires confirm=DELETE.");
  }
  if (body.verificationComplete !== true) {
    throw new Error("Final delete approval requires verificationComplete=true.");
  }
  assertMutatingActionsAllowed("Plex final delete");

  const plan = JSON.parse(stripBom(await readFile(planPath, "utf8")));
  const requestedPlanId = stringValue(body.planId || plan.planId);
  if (requestedPlanId !== stringValue(plan.planId)) {
    throw new Error("Final delete approval planId does not match the latest cleanup plan.");
  }
  const quarantine = asArray(plan.stages).find((stage) => stage.id === "quarantine");
  const plexRescan = asArray(plan.stages).find((stage) => stage.id === "plex_rescan");
  if (quarantine?.status !== "complete") throw new Error("Final delete is blocked until quarantine is complete.");
  if (plexRescan?.status !== "complete") throw new Error("Final delete is blocked until Plex rescan is complete.");
  const verificationBefore = verificationSummaryForPlan(plan);
  if (!verificationBefore.complete) {
    throw new Error(`Final action is blocked until every movie is verified or marked as an issue (${verificationBefore.resolved}/${verificationBefore.total} resolved).`);
  }

  const approvedAt = new Date().toISOString();
  updatePlanStage(plan, "final_delete_approval", { status: "running", approvedAt });
  const pendingRestores = pendingRestoreMovesForPlan(plan);
  const restoreResults = [];
  for (const move of pendingRestores) {
    restoreResults.push(await applyPlexRestoreForMove(
      plan,
      move,
      remoteAddress,
      getVerificationChecks(plan)[move.verificationKey || verificationKeyForMove(move)]?.issueNote || "Playback failed; restored quarantined duplicate.",
      new Date().toISOString()
    ));
    await savePlexCleanupPlan(plan);
  }
  const verificationAfterRestores = verificationSummaryForPlan(plan);
  updatePlanStage(plan, "verification", {
    status: "complete",
    completedAt: approvedAt,
    checkedItems: verificationAfterRestores.resolved,
    restoredItems: verificationAfterRestores.restored,
    issueItems: verificationAfterRestores.issues,
    totalItems: verificationAfterRestores.total
  });
  const deletePaths = finalDeletePathsForPlan(plan);
  plan.deleteResult = await runTrueNasCommand(buildPlexDeleteCommand(deletePaths), `homeops plex duplicate final delete ${plan.planId}`, 900);
  plan.finalDeleteSummary = parsePlexFinalDeleteSummary(plan.deleteResult.output, plan);
  plan.finalRestoreSummary = {
    restoredCount: restoreResults.filter((result) => !result.skipped).length,
    skippedCount: restoreResults.filter((result) => result.skipped).length,
    restoredItems: restoreResults
  };
  try {
    plan.postDeletePlexRescanResult = await runTrueNasCommand(buildPlexLibraryRescanCommand(), `homeops plex duplicate post-delete rescan ${plan.planId}`, 900);
    plan.postDeleteDuplicateScanResult = await runNodeScript("Find-PlexDuplicateMovies.js", [], 180_000);
  } catch (error) {
    plan.postDeleteRescanError = error.message;
  }
  plan.status = "deleted";
  plan.finalDeleteApproval = {
    approvedAt,
    approvedBy: remoteAddress,
    confirm: "DELETE",
    verificationComplete: true,
    note: stringValue(body.note).slice(0, 1000),
    approvalMeaning: "Authorized restoring issue-marked movies, deleting verified quarantined duplicates, and deleting failed current files that were moved to quarantine during restore."
  };
  plan.stages = asArray(plan.stages).map((stage) => {
    if (stage.id === "verification") return { ...stage, status: "complete", completedAt: approvedAt };
    if (stage.id === "final_delete_approval") return { ...stage, status: "complete", approvedAt, completedAt: new Date().toISOString() };
    return stage;
  });

  const saved = await savePlexCleanupPlan(plan);
  await writeCommandLog({
    id: randomUUID().replaceAll("-", ""),
    receivedAt: approvedAt,
    remoteAddress,
    action: "plex.duplicates.final-delete-approval",
    status: "completed",
    result: {
      message: "Final cleanup approval recorded, issue restores applied, and approved quarantine files deleted.",
      planId: plan.planId,
      moveCount: plan.moveCount,
      restoredCount: plan.finalRestoreSummary.restoredCount,
      deletedFileCount: plan.finalDeleteSummary.deletedFileCount,
      deletedFolderCount: plan.finalDeleteSummary.deletedFolderCount,
      postDeletePlexRescan: plan.postDeletePlexRescanResult ? "completed" : "failed",
      postDeleteDuplicateScan: plan.postDeleteDuplicateScanResult ? "completed" : "failed",
      postDeleteRescanError: plan.postDeleteRescanError || "",
      jsonPath: saved.jsonPath,
      mdPath: saved.mdPath
    }
  });
  return plan.finalDeleteApproval;
}

function renderPlexCleanupPlanMarkdown(plan) {
  const lines = [
    "# Plex Duplicate Cleanup Plan",
    "",
    `Created: ${plan.createdAt}`,
    `Plan ID: ${plan.planId}`,
    `Status: ${plan.status}`,
    "",
    "Safety: approved files are quarantined first. Final deletion is blocked until quarantine, Plex rescan, and playback verification are complete.",
    "",
    "## Required Workflow",
    "",
    "| Stage | Status | Approval | Confirmation |",
    "|---|---|---|---|",
    ...asArray(plan.stages).map((stage) => `| ${escapeMarkdownTable(stage.label)} | ${escapeMarkdownTable(stage.status)} | ${stage.requiresApproval ? "Required" : "Not required"} | ${escapeMarkdownTable(stage.confirm || "-")} |`),
    "",
    "Deletion is blocked until Plex verification is marked complete and final delete approval is submitted.",
    "",
    "## Next Steps",
    "",
    ...plan.nextSteps.map((step) => `- ${step}`),
    "",
    "## Planned Quarantine Moves",
    "",
    "| # | Title | Mode | Source | Quarantine | Reason |",
    "|---|---|---|---|---|---|",
  ];
  plan.moves.forEach((move, index) => {
    lines.push(`| ${index + 1} | ${escapeMarkdownTable(move.title)} | ${escapeMarkdownTable(move.cleanupMode || "candidate")} | \`${escapeMarkdownTable(move.source)}\` | \`${escapeMarkdownTable(move.quarantine)}\` | ${escapeMarkdownTable(move.reason)} |`);
  });
  lines.push(
    "",
    "## Source Folders",
    "",
    "These are the folders the removed files came from. During quarantine, a listed folder is removed only if it is safely under the Plex media tree and no movie files remain in that folder tree.",
    "",
    ...asArray(plan.sourceFolders).map((folder) => `- \`${folder}\``)
  );
  const cleanup = plan.sourceFolderCleanup || {};
  if (asArray(cleanup.removed).length || asArray(cleanup.kept).length || asArray(cleanup.skipped).length || asArray(cleanup.alreadyMissing).length) {
    lines.push(
      "",
      "## Source Folder Cleanup Result",
      "",
      ...asArray(cleanup.removed).map((folder) => `- Removed: \`${folder}\``),
      ...asArray(cleanup.kept).map((folder) => `- Kept, movie files remain: \`${folder}\``),
      ...asArray(cleanup.skipped).map((folder) => `- Skipped: \`${folder}\``),
      ...asArray(cleanup.alreadyMissing).map((folder) => `- Already missing: \`${folder}\``)
    );
  }
  const verification = verificationItemsForPlan(plan);
  if (verification.length) {
    lines.push(
      "",
      "## Playback Verification",
      "",
      "| Title | Status | Issue | Quarantined File |",
      "|---|---|---|---|",
      ...verification.map((item) => `| ${escapeMarkdownTable(item.title)} | ${escapeMarkdownTable(item.status)} | ${escapeMarkdownTable(item.issueNote || "-")} | \`${escapeMarkdownTable(item.quarantinedFile)}\` |`)
    );
  }
  const finalDelete = plan.finalDeleteSummary || (plan.deleteResult?.output ? parsePlexFinalDeleteSummary(plan.deleteResult.output, plan) : null);
  if (finalDelete) {
    lines.push(
      "",
      "## Final Delete Verification",
      "",
      `Deleted files: ${finalDelete.deletedFileCount || 0}`,
      `Deleted folders: ${finalDelete.deletedFolderCount || 0}`,
      `Kept folders: ${finalDelete.keptFolderCount || 0}`,
      "",
      "| Title | Deleted File | Folder |",
      "|---|---|---|",
      ...asArray(finalDelete.deletedFiles).map((entry) => `| ${escapeMarkdownTable(entry.title || "-")} | \`${escapeMarkdownTable(entry.file)}\` | \`${escapeMarkdownTable(entry.folder)}\` |`)
    );
    if (asArray(finalDelete.deletedFolders).length) {
      lines.push(
        "",
        "### Deleted Folders",
        "",
        ...asArray(finalDelete.deletedFolders).map((folder) => `- \`${folder}\``)
      );
    }
    if (asArray(finalDelete.keptFolders).length) {
      lines.push(
        "",
        "### Folders Left In Place",
        "",
        ...asArray(finalDelete.keptFolders).map((folder) => `- \`${folder}\``)
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}

function escapeMarkdownTable(value) {
  return stringValue(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

async function approvePlexDuplicateReport(body, remoteAddress) {
  const report = await getPlexDuplicateReport();
  if (!report?.path) throw new Error("No Plex duplicate report is available to approve.");
  const requestedPath = stringValue(body.reportPath || report.path);
  const resolved = path.resolve(requestedPath);
  if (resolved !== path.resolve(report.path)) {
    throw new Error("Approval report path does not match the latest Plex duplicate report.");
  }

  const entry = {
    id: randomUUID().replaceAll("-", ""),
    approvedAt: new Date().toISOString(),
    remoteAddress,
    reportPath: report.path,
    reportGeneratedAt: report.generatedAt,
    summary: report.summary,
    note: stringValue(body.note).slice(0, 1000),
    approvalMeaning: "Report reviewed only. Does not authorize deleting, moving, renaming, or editing media files."
  };
  const approvalPath = path.join(homeOpsRoot, "logs", "plex-duplicate-report-approvals.jsonl");
  await mkdir(path.dirname(approvalPath), { recursive: true });
  await appendFile(approvalPath, `${JSON.stringify(entry)}\n`, "utf8");
  await writeCommandLog({
    id: entry.id,
    receivedAt: entry.approvedAt,
    remoteAddress,
    action: "plex.duplicates.approve",
    status: "completed",
    result: {
      message: "Plex duplicate report approval recorded. No media cleanup was authorized.",
      reportPath: report.path
    }
  });
  return entry;
}

async function getLatestPlexDuplicateApproval(reportGeneratedAt, reportPath) {
  const approvalPath = path.join(homeOpsRoot, "logs", "plex-duplicate-report-approvals.jsonl");
  if (!existsSync(approvalPath)) return null;
  try {
    const raw = await readFile(approvalPath, "utf8");
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .filter((entry) => entry.reportGeneratedAt === reportGeneratedAt || path.resolve(entry.reportPath || "") === path.resolve(reportPath || ""))
      .sort((a, b) => String(b.approvedAt).localeCompare(String(a.approvedAt)))[0] || null;
  } catch {
    return null;
  }
}

async function getCompactHomeOpsReport() {
  const report = await getLatestJsonReport(/^homeops-\d{8}-\d{6}\.json$/);
  if (!report?.data) return report;
  const data = report.data;
  report.data = {
    generatedAt: data.generatedAt,
    computer: data.computer,
    healthy: data.healthy,
    devices: asArray(data.devices).map((device) => ({
      name: device.name,
      role: device.role,
      host: device.host,
      healthy: device.healthy,
      tcp: asArray(device.tcp).map((tcp) => ({ port: tcp.port, open: tcp.open, latencyMs: tcp.latencyMs })),
      http: asArray(device.http).map((http) => ({ name: http.name, ok: http.ok, statusCode: http.statusCode, required: http.required })),
      findings: asArray(device.findings)
    }))
  };
  return report;
}

async function getCompactHomeAssistantReport() {
  const report = await getLatestJsonReport(/^homeassistant-\d{8}-\d{6}\.json$/);
  if (!report?.data) return report;
  const data = report.data;
  report.data = {
    generatedAt: data.generatedAt,
    apiMessage: data.apiMessage,
    version: data.version,
    locationName: data.locationName,
    timeZone: data.timeZone,
    entityCount: data.entityCount,
    serviceDomainCount: data.serviceDomainCount,
    unavailableOrUnknownCount: data.unavailableOrUnknownCount,
    lowBatteryCount: data.lowBatteryCount,
    unavailableOrUnknown: asArray(data.unavailableOrUnknown).slice(0, 24).map(compactEntityState),
    lowBattery: asArray(data.lowBattery).slice(0, 24).map(compactEntityState)
  };
  return report;
}

function compactEntityState(state) {
  return {
    entity_id: state.entity_id,
    state: state.state,
    attributes: {
      friendly_name: state.attributes?.friendly_name
    }
  };
}

async function getLatestJsonReport(namePattern) {
  if (!existsSync(reportsRoot)) return null;
  const names = await readdir(reportsRoot);
  const files = names
    .filter((name) => namePattern.test(name))
    .map((name) => {
      const fullPath = path.join(reportsRoot, name);
      return { fullPath, mtimeMs: statSync(fullPath).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (files.length === 0) return null;
  const file = files[0];
  try {
    return {
      path: file.fullPath,
      generatedAt: new Date(file.mtimeMs).toISOString(),
      data: JSON.parse(stripBom(await readFile(file.fullPath, "utf8")))
    };
  } catch (error) {
    return { path: file.fullPath, generatedAt: new Date(file.mtimeMs).toISOString(), error: error.message };
  }
}

async function getTextReport(name) {
  const filePath = path.join(reportsRoot, name);
  if (!existsSync(filePath)) return null;
  return {
    path: filePath,
    generatedAt: statSync(filePath).mtime.toISOString(),
    text: await readFile(filePath, "utf8")
  };
}

function asArray(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

async function invokeRemoteCommand(body, remoteAddress) {
  const action = resolveRequestedAction(body);
  const entry = {
    id: randomUUID().replaceAll("-", ""),
    receivedAt: new Date().toISOString(),
    remoteAddress,
    action,
    text: stringValue(body.text),
    status: "received"
  };

  try {
    if (action === "homeops.check") {
      entry.result = await runPowerShellScript("Invoke-HomeOpsCheck.ps1", [], 120_000);
      entry.status = "completed";
    } else if (action === "homeassistant.monitor") {
      entry.result = await runPowerShellScript("Invoke-HomeAssistantMonitor.ps1", [], 120_000);
      entry.status = "completed";
    } else if (action === "lan.inventory") {
      entry.result = await runPowerShellScript("Invoke-LanInventory.ps1", [], 240_000);
      entry.status = "completed";
    } else if (action === "plex.duplicates.scan") {
      entry.result = await runNodeScript("Find-PlexDuplicateMovies.js", [], 180_000);
      entry.status = "completed";
    } else if (action === "homeassistant.service.dryrun") {
      entry.result = await runHomeAssistantService(body, false);
      entry.status = "completed";
    } else if (action === "homeassistant.service.apply") {
      entry.result = await runHomeAssistantService(body, true);
      entry.status = "completed";
    } else {
      entry.status = "queued_for_review";
      entry.result = { message: "Message recorded for review. It was not executed automatically." };
    }
  } catch (error) {
    entry.status = "failed";
    entry.error = error.message;
  }

  await writeCommandLog(entry);
  return entry;
}

function resolveRequestedAction(body) {
  if (stringValue(body.action)) return stringValue(body.action);
  const text = stringValue(body.text).toLowerCase();
  if (/(home\s*assistant|(^|\s)ha(\s|$))/.test(text) && /(check|health|monitor|status|refresh)/.test(text)) return "homeassistant.monitor";
  if (/plex/.test(text) && /(duplicate|duplicates|dupe|dupes)/.test(text) && /(scan|check|refresh|report)/.test(text)) return "plex.duplicates.scan";
  if (/(inventory|scan)/.test(text)) return "lan.inventory";
  if (/(health|status|check|refresh)/.test(text)) return "homeops.check";
  return "message";
}

async function runHomeAssistantService(body, apply) {
  if (apply && !config.allowMutatingActions) throw new Error("Mutating actions are disabled in the local HomeOps Remote config.");
  if (apply && stringValue(body.confirm) !== "APPLY") throw new Error("Applying a Home Assistant service requires confirm=APPLY.");

  const domain = assertName(body.domain, "domain");
  const service = assertName(body.service, "service");
  const args = ["-Domain", domain, "-Service", service];
  for (const entityId of asArray(body.entityId)) {
    args.push("-EntityId", assertEntityId(entityId));
  }

  let tempJson = null;
  try {
    if (body.data !== undefined) {
      tempJson = path.join(tmpdir(), `homeops-ha-service-${randomUUID()}.json`);
      await writeFile(tempJson, JSON.stringify(body.data), "utf8");
      args.push("-BodyJsonPath", tempJson);
    }
    if (apply) args.push("-Apply");
    return await runPowerShellScript("Invoke-HomeAssistantService.ps1", args, 90_000);
  } finally {
    if (tempJson) await rm(tempJson, { force: true });
  }
}

function assertName(value, label) {
  const text = stringValue(value);
  if (!/^[a-z0-9_]+$/.test(text)) throw new Error(`${label} may only contain lowercase letters, numbers, and underscores.`);
  return text;
}

function assertEntityId(value) {
  const text = stringValue(value);
  if (!/^[a-z0-9_]+\.[a-z0-9_]+$/.test(text)) throw new Error(`Invalid Home Assistant entity_id: ${text}`);
  return text;
}

function stringValue(value) {
  return value === null || value === undefined ? "" : String(value);
}

function runPowerShellScript(scriptName, scriptArgs, timeoutMs) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(scriptsRoot, scriptName);
    if (!existsSync(scriptPath)) {
      reject(new Error(`Script not found: ${scriptPath}`));
      return;
    }

    const child = spawn(powershellPath, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...scriptArgs], {
      cwd: homeOpsRoot,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    const startedAt = new Date();
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Command timed out after ${Math.round(timeoutMs / 1000)} seconds: ${scriptName}`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Command failed with exit code ${code}: ${stderr || stdout}`));
        return;
      }
      resolve({
        script: scriptName,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        exitCode: code,
        output: stdout.trim(),
        error: stderr.trim()
      });
    });
  });
}

function runNodeScript(scriptName, scriptArgs, timeoutMs) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(scriptsRoot, scriptName);
    if (!existsSync(scriptPath)) {
      reject(new Error(`Script not found: ${scriptPath}`));
      return;
    }

    const child = spawn(process.execPath, [scriptPath, ...scriptArgs], {
      cwd: homeOpsRoot,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    const startedAt = new Date();
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Command timed out after ${Math.round(timeoutMs / 1000)} seconds: ${scriptName}`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Command failed with exit code ${code}: ${stderr || stdout}`));
        return;
      }
      resolve({
        script: scriptName,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        exitCode: code,
        output: stdout.trim(),
        error: stderr.trim()
      });
    });
  });
}

async function writeCommandLog(entry) {
  await mkdir(path.dirname(commandLogPath), { recursive: true });
  await appendFile(commandLogPath, `${JSON.stringify(entry)}\n`, "utf8");
}

async function getRecentCommandLog(limit = 50) {
  if (!existsSync(commandLogPath)) return [];
  const raw = await readFile(commandLogPath, "utf8");
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-limit)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

