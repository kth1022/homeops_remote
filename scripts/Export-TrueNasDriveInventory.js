#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const TRUENAS_URL = "https://192.168.1.34";
const TRUENAS_WSS = "wss://192.168.1.34/api/current";
const API_KEY_PATH = "config/truenas.codex.api-key.xml";
const OUTPUT_DOC = "runbooks/truenas-drive-inventory.md";

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
  if (result.status !== 0) throw new Error((result.stderr || "").trim() || String(result.error) || "Failed to decrypt TrueNAS API key.");
  const key = result.stdout.trim();
  if (!key) throw new Error("TrueNAS API key file decrypted to an empty value.");
  return key;
}

async function connect(apiKey) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  const ws = new WebSocket(TRUENAS_WSS, { headers: { Origin: TRUENAS_URL } });
  const pending = new Map();
  let nextId = 1;

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

function isoStamp() {
  return new Date().toISOString().replace(/\..+/, "Z");
}

function fileStamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z");
}

function tb(size) {
  if (!Number.isFinite(size)) return "";
  return `${(size / 1_000_000_000_000).toFixed(2)} TB`;
}

function tableEscape(value) {
  return String(value ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/\|/g, "\\|");
}

function stripPartition(device) {
  return String(device || "").replace(/p?\d+$/, "");
}

function sortDiskName(name) {
  return String(name || "").replace(/^sd/, "");
}

function collectLeaves(vdev, section, poolName, pathParts = []) {
  const currentPath = [...pathParts, vdev.name || vdev.type || "vdev"];
  if (vdev.type === "DISK" || !Array.isArray(vdev.children) || vdev.children.length === 0) {
    return [{ ...vdev, section, poolName, vdevPath: currentPath.join(" / ") }];
  }

  return vdev.children.flatMap((child) => collectLeaves(child, section, poolName, currentPath));
}

function diskIndex(disks) {
  const byName = new Map();
  const byGuid = new Map();
  for (const disk of disks) {
    if (disk.name) byName.set(disk.name, disk);
    if (disk.devname) byName.set(disk.devname, disk);
    if (disk.zfs_guid) byGuid.set(String(disk.zfs_guid), disk);
  }
  return { byName, byGuid };
}

function enrichLeaf(leaf, indexes) {
  const diskName = stripPartition(leaf.disk || leaf.device || leaf.name);
  const disk = indexes.byName.get(diskName) || indexes.byGuid.get(String(leaf.guid)) || leaf.unavail_disk || {};
  const fallback = leaf.unavail_disk || {};
  return {
    pool: leaf.poolName,
    section: leaf.section,
    vdevPath: leaf.vdevPath,
    vdevStatus: leaf.status,
    device: leaf.device || "",
    diskName,
    model: disk.model || fallback.model || "",
    serial: disk.serial || fallback.serial || "",
    size: disk.size || fallback.size || null,
    type: disk.type || fallback.type || "",
    rotationrate: disk.rotationrate ?? fallback.rotationrate ?? "",
    zfsGuid: leaf.guid || disk.zfs_guid || fallback.zfs_guid || "",
    identifier: disk.identifier || fallback.identifier || "",
    lunid: disk.lunid || fallback.lunid || "",
    partPath: leaf.path || "",
    readErrors: leaf.stats?.read_errors ?? "",
    writeErrors: leaf.stats?.write_errors ?? "",
    checksumErrors: leaf.stats?.checksum_errors ?? "",
    matched: Boolean(disk.model || disk.serial),
  };
}

function makeMarkdown({ pools, disks, rawReportPath, generatedAt }) {
  const indexes = diskIndex(disks);
  const usedDiskNames = new Set();
  const lines = [];
  const allRows = [];

  for (const pool of pools) {
    for (const section of ["data", "special", "dedup", "log", "cache", "spare"]) {
      for (const vdev of pool.topology?.[section] || []) {
        const rows = collectLeaves(vdev, section, pool.name).map((leaf) => enrichLeaf(leaf, indexes));
        rows.forEach((row) => {
          if (row.diskName) usedDiskNames.add(row.diskName);
          allRows.push(row);
        });
      }
    }
  }

  const unmatched = allRows.filter((row) => !row.matched);
  const unassigned = disks
    .filter((disk) => !usedDiskNames.has(disk.name))
    .sort((a, b) => sortDiskName(a.name).localeCompare(sortDiskName(b.name), undefined, { numeric: true }));

  lines.push("# TrueNAS Drive Inventory");
  lines.push("");
  lines.push(`Generated: ${generatedAt}`);
  lines.push("");
  lines.push("Purpose: map every TrueNAS pool vdev member to its serial number, model, and future physical bay position for drive replacement.");
  lines.push("");
  lines.push("Verification sources:");
  lines.push("- TrueNAS `pool.query` for pool, vdev, status, and ZFS GUID topology.");
  lines.push("- TrueNAS `disk.query` for current disk serial, model, size, type, and LUN ID.");
  lines.push(`- Raw snapshot: \`${rawReportPath}\`.`);
  lines.push("");
  lines.push("Bay positions are intentionally blank until physically confirmed.");
  lines.push("");

  for (const pool of pools) {
    lines.push(`## Pool: ${pool.name}`);
    lines.push("");
    lines.push(`Status: ${pool.status}${pool.status_code ? ` (${pool.status_code})` : ""}`);
    if (pool.status_detail) lines.push(`Detail: ${pool.status_detail}`);
    lines.push("");

    for (const section of ["data", "special", "dedup", "log", "cache", "spare"]) {
      const vdevs = pool.topology?.[section] || [];
      if (vdevs.length === 0) continue;
      lines.push(`### ${section[0].toUpperCase()}${section.slice(1)} vdevs`);
      lines.push("");

      for (const vdev of vdevs) {
        const rows = collectLeaves(vdev, section, pool.name).map((leaf) => enrichLeaf(leaf, indexes));
        lines.push(`#### ${vdev.name || section} (${vdev.type || "unknown"}, ${vdev.status || "unknown"})`);
        lines.push("");
        lines.push("| Bay | Disk | Status | Read Err | Write Err | Checksum Err | Model | Serial | Size | Type | RPM | ZFS GUID | LUN ID | Part path |");
        lines.push("|---|---|---|---:|---:|---:|---|---|---:|---|---:|---|---|---|");
        for (const row of rows) {
          lines.push(
            `| TBD | ${tableEscape(row.diskName)} | ${tableEscape(row.vdevStatus)} | ${tableEscape(row.readErrors)} | ${tableEscape(row.writeErrors)} | ${tableEscape(row.checksumErrors)} | ${tableEscape(row.model)} | ${tableEscape(row.serial)} | ${tableEscape(tb(row.size))} | ${tableEscape(row.type)} | ${tableEscape(row.rotationrate)} | ${tableEscape(row.zfsGuid)} | ${tableEscape(row.lunid)} | ${tableEscape(row.partPath)} |`,
          );
        }
        lines.push("");
      }
    }
  }

  if (unassigned.length > 0) {
    lines.push("## Detected Disks Not In Current Pool Topology");
    lines.push("");
    lines.push("| Disk | Model | Serial | Size | Type | RPM | ZFS GUID | LUN ID | Notes |");
    lines.push("|---|---|---|---:|---|---:|---|---|---|");
    for (const disk of unassigned) {
      const notes = disk.type === "SSD" ? "Not listed as a pool vdev member in `pool.query`; likely boot or standalone device." : "Not listed as a current pool vdev member in `pool.query`; verify before reuse or removal.";
      lines.push(
        `| ${tableEscape(disk.name)} | ${tableEscape(disk.model)} | ${tableEscape(disk.serial)} | ${tableEscape(tb(disk.size))} | ${tableEscape(disk.type)} | ${tableEscape(disk.rotationrate)} | ${tableEscape(disk.zfs_guid)} | ${tableEscape(disk.lunid)} | ${tableEscape(notes)} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Verification Notes");
  lines.push("");
  lines.push(`- Pool vdev leaves found: ${allRows.length}.`);
  lines.push(`- Vdev leaves matched to model/serial data: ${allRows.length - unmatched.length}.`);
  lines.push(`- Unmatched vdev leaves: ${unmatched.length}.`);
  if (unmatched.length > 0) {
    for (const row of unmatched) {
      lines.push(`- Unmatched: ${row.pool} ${row.vdevPath} ${row.device || row.diskName || row.zfsGuid}`);
    }
  }
  lines.push("");
  lines.push("When bay positions are known, replace `TBD` in the Bay column with the physical bay label.");
  lines.push("");

  return lines.join("\n");
}

async function main() {
  const apiKey = decryptApiKey(API_KEY_PATH);
  const { ws, call } = await connect(apiKey);
  try {
    const [pools, disks] = await Promise.all([call("pool.query"), call("disk.query")]);
    const generatedAt = isoStamp();
    const rawReportPath = path.join("reports", `truenas-drive-inventory-${fileStamp()}.json`);
    const raw = { generatedAt, truenasUrl: TRUENAS_URL, pools, disks };

    fs.mkdirSync(path.dirname(rawReportPath), { recursive: true });
    fs.mkdirSync(path.dirname(OUTPUT_DOC), { recursive: true });
    fs.writeFileSync(rawReportPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    fs.writeFileSync(OUTPUT_DOC, makeMarkdown({ pools, disks, rawReportPath, generatedAt }), "utf8");

    console.log(JSON.stringify({ outputDoc: OUTPUT_DOC, rawReport: rawReportPath }, null, 2));
  } finally {
    ws.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
