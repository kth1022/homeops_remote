#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function decryptApiKey(apiKeyPath) {
  const command = `
function ConvertFrom-SecureStringPlainText([securestring]$s) {
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}
ConvertFrom-SecureStringPlainText (Import-Clixml -LiteralPath '${apiKeyPath.replace(/'/g, "''")}')
`;
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(result.stderr.trim() || "Failed to decrypt TrueNAS API key.");
  return result.stdout.trim();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function connect() {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  const apiKey = decryptApiKey("config/truenas.codex.api-key.xml");
  const ws = new WebSocket("wss://192.168.1.34/api/current", { headers: { Origin: "https://192.168.1.34" } });
  let nextId = 1;
  const pending = new Map();
  function call(method, params = []) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const pendingCall = pending.get(message.id);
    if (!pendingCall) return;
    pending.delete(message.id);
    if (message.error) pendingCall.reject(new Error(JSON.stringify(message.error)));
    else pendingCall.resolve(message.result);
  };
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out connecting to TrueNAS.")), 15000);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("Failed to connect to TrueNAS."));
    };
  });
  if (!(await call("auth.login_with_api_key", [apiKey]))) throw new Error("TrueNAS API key authentication failed.");
  return { ws, call };
}

async function waitJob(call, jobId) {
  for (let i = 0; i < 60; i += 1) {
    const job = (await call("core.get_jobs", [[["id", "=", jobId]], { extra: { raw_result: true } }]))[0];
    if (job && ["SUCCESS", "FAILED", "ABORTED"].includes(job.state)) {
      if (job.state !== "SUCCESS") throw new Error(job.error || job.state);
      return;
    }
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for job ${jobId}.`);
}

async function runCron(call, command) {
  const cron = await call("cronjob.create", [
    { enabled: false, stdout: false, stderr: false, command, user: "root", description: "codex compare progress" },
  ]);
  try {
    const jobId = await call("cronjob.run", [cron.id, false]);
    await waitJob(call, jobId);
  } finally {
    try {
      await call("cronjob.delete", [cron.id]);
    } catch {
      // Best effort cleanup.
    }
  }
}

async function download(call, remotePath, localPath) {
  const [jobId, url] = await call("core.download", ["filesystem.get", [remotePath], path.basename(localPath), true]);
  const response = await fetch(`https://192.168.1.34${url}`);
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  fs.writeFileSync(localPath, Buffer.from(await response.arrayBuffer()));
  await waitJob(call, jobId);
}

async function main() {
  const dir = process.argv[2] || "";
  const targetExpr = dir
    ? `d=${dir}`
    : "d=$(ls -dt /tmp/immich-untracked-readonly-compare-* | head -n1)";
  const remote = "/tmp/codex-immich-compare-progress.txt";
  const local = "reports/immich-compare-progress.txt";
  const command = `sh -lc '${targetExpr}; echo dir=$d; echo hashes=$(wc -l < "$d/summary.json.hashes.tsv" 2>/dev/null || echo 0); echo errors=$(wc -l < "$d/summary.json.hashes.err" 2>/dev/null || echo 0); test -f "$d/summary.json" && echo summary=present || echo summary=absent; tail -n 1 "$d/summary.json.hashes.tsv" 2>/dev/null || true; ps aux | grep $(basename "$d") | grep -v grep || true' > ${remote}`;
  const { ws, call } = await connect();
  try {
    await runCron(call, command);
    await download(call, remote, local);
    process.stdout.write(fs.readFileSync(local, "utf8"));
  } finally {
    ws.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
