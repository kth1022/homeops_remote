#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function argValue(args, name, fallback) {
  const idx = args.indexOf(name);
  if (idx === -1) return fallback;
  if (idx === args.length - 1) throw new Error(`Missing value for ${name}`);
  return args[idx + 1];
}

function decryptApiKey(apiKeyPath) {
  if (process.env.TRUENAS_API_KEY) return process.env.TRUENAS_API_KEY;

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
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || "Failed to decrypt TrueNAS API key.");
  const key = result.stdout.trim();
  if (!key) throw new Error("TrueNAS API key file decrypted to an empty value.");
  return key;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function connect(apiKey) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
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

  if (!(await call("auth.login_with_api_key", [apiKey]))) {
    throw new Error("TrueNAS API key authentication failed.");
  }
  return { ws, call };
}

async function waitJob(call, jobId, timeoutSec) {
  for (let i = 0; i < timeoutSec; i += 1) {
    const jobs = await call("core.get_jobs", [[["id", "=", jobId]], { extra: { raw_result: true } }]);
    const job = jobs[0];
    if (job && ["SUCCESS", "FAILED", "ABORTED"].includes(job.state)) {
      return job;
    }
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for TrueNAS job ${jobId}.`);
}

async function download(call, remotePath, localPath) {
  const [jobId, url] = await call("core.download", ["filesystem.get", [remotePath], path.basename(localPath), true]);
  const response = await fetch(`https://192.168.1.34${url}`);
  if (!response.ok) throw new Error(`TrueNAS download failed with HTTP ${response.status}.`);
  fs.writeFileSync(localPath, Buffer.from(await response.arrayBuffer()));
  const job = await waitJob(call, jobId, 120);
  if (job.state !== "SUCCESS") throw new Error(`Download job ${jobId} ${job.state}: ${job.error || ""}`);
}

async function uploadFile(apiKey, call, localPath, remotePath, mode = null) {
  const form = new FormData();
  form.append("data", JSON.stringify({ method: "filesystem.put", params: [remotePath, { append: false, mode }] }));
  form.append("file", new Blob([fs.readFileSync(localPath)]), path.basename(localPath));
  const response = await fetch("https://192.168.1.34/_upload/", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`TrueNAS upload failed with HTTP ${response.status}: ${body}`);
  const parsed = JSON.parse(body);
  const job = await waitJob(call, parsed.job_id, 120);
  if (job.state !== "SUCCESS") throw new Error(`Upload job ${parsed.job_id} ${job.state}: ${job.error || ""}`);
}

async function main() {
  const args = process.argv.slice(2);
  let command = argValue(args, "--command", "");
  const commandFile = argValue(args, "--command-file", "");
  if (commandFile) {
    command = fs.readFileSync(commandFile, "utf8");
  }
  if (!command) throw new Error("Missing --command or --command-file.");
  const timeoutSec = Number(argValue(args, "--timeout-sec", "300"));
  const description = argValue(args, "--description", "codex truenas command");
  const outputPath = argValue(args, "--output", "");

  fs.mkdirSync("logs", { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const localOutput = outputPath || path.join("logs", `truenas-command-${stamp}.log`);
  const remoteOutput = `/tmp/codex-truenas-command-${stamp}.log`;
  const encodedCommand = Buffer.from(command, "utf8").toString("base64");

  const apiKey = decryptApiKey(argValue(args, "--api-key-path", "config/truenas.codex.api-key.xml"));
  const { ws, call } = await connect(apiKey);
  try {
    let wrapped = `printf %s ${encodedCommand} | base64 -d | sh > ${remoteOutput} 2>&1`;
    if (wrapped.length > 900) {
      const remoteScript = `/tmp/codex-truenas-command-${stamp}.sh`;
      if (!commandFile) {
        const localScript = path.join("logs", `truenas-command-${stamp}.sh`);
        fs.writeFileSync(localScript, command, "utf8");
        await uploadFile(apiKey, call, localScript, remoteScript, 0o700);
      } else {
        await uploadFile(apiKey, call, commandFile, remoteScript, 0o700);
      }
      wrapped = `sh ${remoteScript} > ${remoteOutput} 2>&1`;
    }
    const cron = await call("cronjob.create", [
      { enabled: false, stdout: false, stderr: false, command: wrapped, description, user: "root" },
    ]);
    let job;
    try {
      const jobId = await call("cronjob.run", [cron.id, false]);
      job = await waitJob(call, jobId, timeoutSec);
    } finally {
      try {
        await call("cronjob.delete", [cron.id]);
      } catch {
        // Best-effort cleanup.
      }
    }
    await download(call, remoteOutput, localOutput);
    process.stdout.write(fs.readFileSync(localOutput, "utf8"));
    if (job.state !== "SUCCESS") {
      throw new Error(`TrueNAS command job ${job.id} ${job.state}: ${job.error || ""}`);
    }
  } finally {
    ws.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
