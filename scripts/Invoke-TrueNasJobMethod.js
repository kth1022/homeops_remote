#!/usr/bin/env node
"use strict";

const fs = require("fs");
const { spawnSync } = require("child_process");

function usage() {
  return `Usage:
  node scripts/Invoke-TrueNasJobMethod.js --method docker.update --params-json '[{"pool":"Apps","migrate_applications":true}]' [--params-json-file params.json] [--timeout-sec 3600] [--output report.json]
`;
}

function argValue(args, name, fallback) {
  const idx = args.indexOf(name);
  if (idx === -1) return fallback;
  if (idx === args.length - 1) throw new Error(`Missing value for ${name}`);
  return args[idx + 1];
}

function decryptApiKey(apiKeyPath) {
  const command = `
function ConvertFrom-SecureStringPlainText([securestring]$s) {
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}
ConvertFrom-SecureStringPlainText (Import-Clixml -LiteralPath '${apiKeyPath.replace(/'/g, "''")}')
`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr.trim() || "Failed to decrypt TrueNAS API key.");
  const key = result.stdout.trim();
  if (!key) throw new Error("TrueNAS API key file decrypted to an empty value.");
  return key;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function connect(baseUrl, apiKey) {
  const url = new URL(baseUrl);
  if (url.protocol !== "wss:") throw new Error(`Refusing insecure TrueNAS API transport: ${baseUrl}.`);

  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  const ws = new WebSocket(baseUrl, { headers: { Origin: "https://192.168.1.34" } });
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
  const startedAt = Date.now();
  while ((Date.now() - startedAt) / 1000 < timeoutSec) {
    const jobs = await call("core.get_jobs", [[["id", "=", jobId]], { extra: { raw_result: true } }]);
    const job = jobs[0];
    if (job && ["SUCCESS", "FAILED", "ABORTED"].includes(job.state)) return job;
    if (job) {
      const percent = job.progress?.percent ?? 0;
      const description = job.progress?.description ?? "";
      console.error(`job=${jobId} state=${job.state} percent=${percent} description=${description}`);
    }
    await sleep(10000);
  }
  throw new Error(`Timed out waiting for TrueNAS job ${jobId}.`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage());
    return;
  }

  const method = argValue(args, "--method");
  if (!method) throw new Error(`Missing --method.\n${usage()}`);
  const paramsFile = argValue(args, "--params-json-file", "");
  const params = JSON.parse(paramsFile ? fs.readFileSync(paramsFile, "utf8") : argValue(args, "--params-json", "[]"));
  if (!Array.isArray(params)) throw new Error("--params-json must be a JSON array.");

  const apiKey = decryptApiKey(argValue(args, "--api-key-path", "config/truenas.codex.api-key.xml"));
  const baseUrl = argValue(args, "--base-url", "wss://192.168.1.34/api/current");
  const timeoutSec = Number(argValue(args, "--timeout-sec", "3600"));
  const output = argValue(args, "--output", "");

  const { ws, call } = await connect(baseUrl, apiKey);
  try {
    const jobId = await call(method, params);
    if (!Number.isInteger(jobId)) {
      console.log(JSON.stringify(jobId, null, 2));
      return;
    }

    console.error(`started job=${jobId}`);
    const job = await waitJob(call, jobId, timeoutSec);
    const text = JSON.stringify(job, null, 2);
    if (output) fs.writeFileSync(output, text);
    console.log(text);
    if (job.state !== "SUCCESS") throw new Error(`TrueNAS job ${jobId} ${job.state}: ${job.error || ""}`);
  } finally {
    ws.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
