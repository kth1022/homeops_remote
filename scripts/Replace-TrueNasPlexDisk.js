#!/usr/bin/env node
"use strict";

const { spawnSync } = require("child_process");

const TRUENAS_URL = "https://192.168.1.34";
const TRUENAS_WSS = "wss://192.168.1.34/api/current";
const API_KEY_PATH = "config/truenas.codex.api-key.xml";
const OLD_SERIAL = "W801CTSX";
const OLD_ZFS_GUID = "61268382269324563";
const NEW_SERIAL = "ZAD385EE";

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

  const authenticated = await call("auth.login_with_api_key", [apiKey]);
  if (!authenticated) throw new Error("TrueNAS API key authentication failed.");
  return { ws, call };
}

async function waitJob(call, jobId, timeoutSec = 60) {
  for (let i = 0; i < timeoutSec; i += 1) {
    const jobs = await call("core.get_jobs", [[["id", "=", jobId]], { extra: { raw_result: true } }]);
    const job = jobs[0];
    if (job && ["SUCCESS", "FAILED", "ABORTED"].includes(job.state)) return job;
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for TrueNAS job ${jobId}.`);
}

function findGuidInTopology(node, guid) {
  if (!node || typeof node !== "object") return null;
  if (String(node.guid) === guid) return node;
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) {
        const match = findGuidInTopology(child, guid);
        if (match) return match;
      }
    } else if (value && typeof value === "object") {
      const match = findGuidInTopology(value, guid);
      if (match) return match;
    }
  }
  return null;
}

async function main() {
  const execute = process.argv.includes("--execute");
  const apiKey = decryptApiKey(API_KEY_PATH);
  const { ws, call } = await connect(apiKey);
  try {
    const pools = await call("pool.query", [[["name", "=", "Plex"]]]);
    const pool = pools[0];
    if (!pool) throw new Error("Plex pool not found.");

    const disks = await call("disk.query", [[["serial", "in", [OLD_SERIAL, NEW_SERIAL]]]]);
    const oldDisk = disks.find((disk) => disk.serial === OLD_SERIAL);
    const newDisk = disks.find((disk) => disk.serial === NEW_SERIAL);
    if (!oldDisk) throw new Error(`Old disk serial ${OLD_SERIAL} not found.`);
    if (!newDisk) throw new Error(`New disk serial ${NEW_SERIAL} not found.`);

    const oldVdev = findGuidInTopology(pool.topology, OLD_ZFS_GUID);
    if (!oldVdev) throw new Error(`Old ZFS GUID ${OLD_ZFS_GUID} not found in Plex topology.`);
    if (newDisk.pool) throw new Error(`New disk ${NEW_SERIAL} is already assigned to pool ${newDisk.pool}.`);
    if (String(oldDisk.zfs_guid) !== OLD_ZFS_GUID) {
      throw new Error(`Old disk ${OLD_SERIAL} zfs_guid=${oldDisk.zfs_guid}, expected ${OLD_ZFS_GUID}.`);
    }

    console.log(
      JSON.stringify(
        {
          execute,
          pool: { id: pool.id, name: pool.name, status: pool.status },
          oldDisk: {
            serial: oldDisk.serial,
            identifier: oldDisk.identifier,
            name: oldDisk.name,
            devname: oldDisk.devname,
            pool: oldDisk.pool,
            zfs_guid: oldDisk.zfs_guid,
            vdev_guid: oldVdev.guid,
            vdev_status: oldVdev.status,
          },
          newDisk: {
            serial: newDisk.serial,
            identifier: newDisk.identifier,
            name: newDisk.name,
            devname: newDisk.devname,
            pool: newDisk.pool,
            zfs_guid: newDisk.zfs_guid,
            size: newDisk.size,
            model: newDisk.model,
          },
        },
        null,
        2,
      ),
    );

    if (!execute) return;

    const jobId = await call("pool.replace", [
      pool.id,
      {
        label: OLD_ZFS_GUID,
        disk: newDisk.identifier,
        force: false,
        preserve_settings: true,
        preserve_description: true,
      },
    ]);
    console.log(`replace_job_id=${jobId}`);
    const job = await waitJob(call, jobId, 120);
    console.log(
      JSON.stringify(
        {
          replace_job_state: job.state,
          replace_job_error: job.error || null,
          replace_job_result: job.result,
        },
        null,
        2,
      ),
    );
    if (job.state !== "SUCCESS") process.exitCode = 2;
  } finally {
    ws.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
