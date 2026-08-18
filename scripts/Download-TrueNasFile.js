#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { pipeline } = require("stream/promises");
const { Readable } = require("stream");

const TRUENAS_URL = "https://192.168.1.34";
const TRUENAS_WSS = "wss://192.168.1.34/api/current";

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

async function connect(apiKey) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  const ws = new WebSocket(TRUENAS_WSS, { headers: { Origin: TRUENAS_URL } });
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

async function downloadFile(call, remotePath, localPath, timeoutSec) {
  const [jobId, url] = await call("core.download", ["filesystem.get", [remotePath], path.basename(localPath), true]);
  const response = await fetch(`${TRUENAS_URL}${url}`);
  if (!response.ok) throw new Error(`TrueNAS download failed with HTTP ${response.status}.`);
  if (!response.body) throw new Error("TrueNAS download response did not include a body.");

  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  const tempPath = `${localPath}.partial`;
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(tempPath));

  const job = await waitJob(call, jobId, timeoutSec);
  if (job.state !== "SUCCESS") throw new Error(`Download job ${jobId} ${job.state}: ${job.error || ""}`);

  fs.renameSync(tempPath, localPath);
}

async function main() {
  const args = process.argv.slice(2);
  const remotePath = argValue(args, "--remote", "");
  const localPath = argValue(args, "--local", "");
  const timeoutSec = Number(argValue(args, "--timeout-sec", "3600"));
  const apiKeyPath = argValue(args, "--api-key-path", "config/truenas.codex.api-key.xml");

  if (!remotePath) throw new Error("Missing --remote.");
  if (!localPath) throw new Error("Missing --local.");

  const apiKey = decryptApiKey(apiKeyPath);
  const { ws, call } = await connect(apiKey);
  try {
    await downloadFile(call, remotePath, localPath, timeoutSec);
    const stat = fs.statSync(localPath);
    console.log(`downloaded=${localPath}`);
    console.log(`bytes=${stat.size}`);
  } finally {
    ws.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
