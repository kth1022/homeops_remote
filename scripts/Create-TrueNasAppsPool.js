#!/usr/bin/env node
"use strict";

const { spawnSync } = require("child_process");

const TRUENAS_URL = "https://192.168.1.34";
const TRUENAS_WSS = "wss://192.168.1.34/api/current";
const API_KEY_PATH = "config/truenas.codex.api-key.xml";
const SSD_SERIAL = "AB202200000031001181";
const POOL_NAME = "Apps";

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

async function waitJob(call, jobId, timeoutSec = 600) {
  for (let i = 0; i < timeoutSec; i += 1) {
    const jobs = await call("core.get_jobs", [[["id", "=", jobId]], { extra: { raw_result: true } }]);
    const job = jobs[0];
    if (job && ["SUCCESS", "FAILED", "ABORTED"].includes(job.state)) return job;
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for TrueNAS job ${jobId}.`);
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

async function getSsd(call) {
  const disks = await call("disk.query", [[["serial", "=", SSD_SERIAL]]]);
  if (disks.length !== 1) throw new Error(`Expected exactly one disk with serial ${SSD_SERIAL}, found ${disks.length}.`);
  const disk = disks[0];
  if (disk.type !== "SSD") throw new Error(`Refusing: serial ${SSD_SERIAL} is type ${disk.type}, expected SSD.`);
  if (disk.size < 1_900_000_000_000) throw new Error(`Refusing: serial ${SSD_SERIAL} size ${disk.size} is smaller than expected.`);
  return disk;
}

async function main() {
  const execute = process.argv.includes("--execute");
  const apiKey = decryptApiKey(API_KEY_PATH);
  const { ws, call } = await connect(apiKey);
  try {
    const pools = await call("pool.query");
    if (pools.some((pool) => pool.name === POOL_NAME)) throw new Error(`Pool ${POOL_NAME} already exists.`);

    let disk = await getSsd(call);
    if (disk.pool) throw new Error(`Refusing: serial ${SSD_SERIAL} is already assigned to pool ${disk.pool}.`);
    if (disk.zfs_guid) throw new Error(`Refusing: serial ${SSD_SERIAL} already has zfs_guid ${disk.zfs_guid}.`);
    if (!disk.identifier) throw new Error(`Refusing: serial ${SSD_SERIAL} has no TrueNAS disk identifier.`);
    if (!disk.name) throw new Error(`Refusing: serial ${SSD_SERIAL} has no current device name.`);

    printJson({
      execute,
      target: {
        pool_name: POOL_NAME,
        serial: disk.serial,
        identifier: disk.identifier,
        name: disk.name,
        devname: disk.devname,
        model: disk.model,
        size: disk.size,
        type: disk.type,
        pool: disk.pool,
        zfs_guid: disk.zfs_guid,
      },
    });

    if (!execute) return;

    const wipeJobId = await call("disk.wipe", [disk.name, "QUICK", true]);
    console.log(`wipe_job_id=${wipeJobId}`);
    const wipeJob = await waitJob(call, wipeJobId, 600);
    printJson({ wipe_job_state: wipeJob.state, wipe_job_error: wipeJob.error || null });
    if (wipeJob.state !== "SUCCESS") throw new Error(`Wipe failed: ${wipeJob.error || wipeJob.exception || wipeJob.state}`);

    await sleep(3000);
    disk = await getSsd(call);
    if (disk.pool) throw new Error(`Refusing after wipe: serial ${SSD_SERIAL} is assigned to pool ${disk.pool}.`);
    if (!disk.identifier) throw new Error(`Refusing after wipe: serial ${SSD_SERIAL} has no TrueNAS disk identifier.`);

    const createJobId = await call("pool.create", [
      {
        name: POOL_NAME,
        encryption: false,
        topology: {
          data: [
            {
              type: "STRIPE",
            disks: [disk.name],
            },
          ],
        },
      },
    ]);
    console.log(`create_job_id=${createJobId}`);
    const createJob = await waitJob(call, createJobId, 900);
    printJson({
      create_job_state: createJob.state,
      create_job_error: createJob.error || null,
      create_job_result: createJob.result,
    });
    if (createJob.state !== "SUCCESS") throw new Error(`Pool create failed: ${createJob.error || createJob.exception || createJob.state}`);

    const createdPools = await call("pool.query", [[["name", "=", POOL_NAME]]]);
    printJson({
      created_pool: createdPools[0]
        ? {
            id: createdPools[0].id,
            name: createdPools[0].name,
            status: createdPools[0].status,
            path: createdPools[0].path,
            healthy: createdPools[0].healthy,
          }
        : null,
    });
  } finally {
    ws.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
