#!/usr/bin/env node
"use strict";

const fs = require("fs");
const { spawnSync } = require("child_process");

function usage() {
  return `Usage:
  node scripts/Invoke-TrueNasJsonRpc.js --method system.info [--params-json "[]"] [--params-json-file params.json] [--api-key-path config/truenas.codex.api-key.xml] [--base-url wss://192.168.1.34/api/current]

Notes:
  - Refuses non-WSS transports.
  - Reads the DPAPI-encrypted API key file via PowerShell and never prints the key.
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
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "Failed to decrypt TrueNAS API key.");
  }
  const key = result.stdout.trim();
  if (!key) throw new Error("TrueNAS API key file decrypted to an empty value.");
  return key;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage());
    return;
  }

  const method = argValue(args, "--method");
  if (!method) throw new Error(`Missing --method.\n${usage()}`);

  const baseUrl = argValue(args, "--base-url", "wss://192.168.1.34/api/current");
  const url = new URL(baseUrl);
  if (url.protocol !== "wss:") {
    throw new Error(`Refusing insecure TrueNAS API transport: ${baseUrl}. Use wss:// only.`);
  }

  const apiKeyPath = argValue(args, "--api-key-path", "config/truenas.codex.api-key.xml");
  const paramsFile = argValue(args, "--params-json-file", "");
  const params = JSON.parse(paramsFile ? fs.readFileSync(paramsFile, "utf8") : argValue(args, "--params-json", "[]"));
  if (!Array.isArray(params)) throw new Error("--params-json must be a JSON array.");

  const apiKey = decryptApiKey(apiKeyPath);

  // TrueNAS on the LAN uses a self-signed certificate. This keeps TLS encryption
  // while allowing that local certificate; do not downgrade to ws://.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

  const ws = new WebSocket(baseUrl, { headers: { Origin: "https://192.168.1.34" } });
  const pending = new Map();
  let nextId = 1;

  function call(rpcMethod, rpcParams) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method: rpcMethod, params: rpcParams }));
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

  try {
    const authenticated = await call("auth.login_with_api_key", [apiKey]);
    if (!authenticated) throw new Error("TrueNAS API key authentication failed.");
    const result = await call(method, params);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    ws.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
