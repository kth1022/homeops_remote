#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const TRUENAS_URL = "https://192.168.1.34";
const TRUENAS_WSS = "wss://192.168.1.34/api/current";
const API_KEY_PATH = "config/truenas.codex.api-key.xml";
const DEFAULT_CSV = "reports/immich-untracked-files-after-safe-cleanup-20260727-231344.csv";

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
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
    { encoding: "utf8" },
  );
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

  const authenticated = await call("auth.login_with_api_key", [apiKey]);
  if (!authenticated) throw new Error("TrueNAS API key authentication failed.");
  return { ws, call };
}

async function waitJob(call, jobId, timeoutSec) {
  for (let i = 0; i < timeoutSec; i += 1) {
    const jobs = await call("core.get_jobs", [[["id", "=", jobId]], { extra: { raw_result: true } }]);
    const job = jobs[0];
    if (job && ["SUCCESS", "FAILED", "ABORTED"].includes(job.state)) {
      if (job.state !== "SUCCESS") {
        throw new Error(`TrueNAS job ${jobId} ${job.state}: ${job.error || job.exception || "no error text"}`);
      }
      return job;
    }
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for TrueNAS job ${jobId}.`);
}

async function uploadFile(apiKey, call, localPath, remotePath, mode = null) {
  const form = new FormData();
  form.append(
    "data",
    JSON.stringify({ method: "filesystem.put", params: [remotePath, { append: false, mode }] }),
  );
  form.append("file", new Blob([fs.readFileSync(localPath)]), path.basename(localPath));
  const response = await fetch(`${TRUENAS_URL}/_upload/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`TrueNAS upload failed with HTTP ${response.status}: ${body}`);
  const parsed = JSON.parse(body);
  await waitJob(call, parsed.job_id, 120);
}

async function runCron(call, command, description, timeoutSec) {
  const cron = await call("cronjob.create", [
    { enabled: false, stdout: false, stderr: false, command, description, user: "root" },
  ]);
  try {
    const jobId = await call("cronjob.run", [cron.id, false]);
    await waitJob(call, jobId, timeoutSec);
    return jobId;
  } finally {
    try {
      await call("cronjob.delete", [cron.id]);
    } catch {
      // Best-effort cleanup of the temporary cron definition.
    }
  }
}

async function downloadFile(call, remotePath, localPath) {
  const [jobId, url] = await call("core.download", [
    "filesystem.get",
    [remotePath],
    path.basename(localPath),
    true,
  ]);
  const response = await fetch(`${TRUENAS_URL}${url}`);
  if (!response.ok) throw new Error(`TrueNAS download failed with HTTP ${response.status}.`);
  fs.writeFileSync(localPath, Buffer.from(await response.arrayBuffer()));
  await waitJob(call, jobId, 120);
}

const remotePython = String.raw`#!/usr/bin/env python3
import csv
import json
import os
import posixpath
import subprocess
import sys
from collections import Counter, defaultdict

input_csv, summary_json, matches_csv, unmatched_csv = sys.argv[1:5]
container_data_root = '/data'
host_data_root = '/mnt/PicCloud/Pictures'

def to_host_path(file_path):
    if not file_path.startswith(container_data_root + '/'):
        return file_path
    return host_data_root + file_path[len(container_data_root):]

def to_container_path(file_path):
    if not file_path.startswith(host_data_root + '/'):
        return file_path
    return container_data_root + file_path[len(host_data_root):]

def run(args, input_bytes=None, timeout=None):
    return subprocess.run(args, input=input_bytes, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout, check=False)

with open(input_csv, newline='', encoding='utf-8') as f:
    rows = list(csv.DictReader(f))

paths = [r['path'] for r in rows]
host_paths = [to_host_path(p) for p in paths]
path_by_id = {r['id']: r['path'] for r in rows}
prefix_counts = Counter('/'.join(p.split('/')[:4]) for p in paths)
ext_counts = Counter(posixpath.splitext(p)[1].lower() or '<none>' for p in paths)

psql_sql = """select id, encode(checksum,'hex') as checksum, lower("originalFileName") as name, "originalPath" as path
from asset
where "deletedAt" is null and checksum is not null;"""
db = run([
    'docker', 'exec', 'immich_postgres',
    'psql', '-At', '-F', '\t', '-U', 'postgres', '-d', 'immich',
    '-c', psql_sql,
], timeout=600)
if db.returncode != 0:
    raise SystemExit(db.stderr.decode('utf-8', 'replace'))

by_sha = defaultdict(list)
by_name = defaultdict(list)
by_path = {}
asset_rows = 0
for raw in db.stdout.decode('utf-8', 'replace').splitlines():
    parts = raw.split('\t')
    if len(parts) < 4:
        continue
    asset_id, checksum, name, original_path = parts[0], parts[1].lower(), parts[2].lower(), parts[3]
    asset_rows += 1
    by_sha[checksum].append((asset_id, name, original_path))
    by_name[name].append((asset_id, checksum, original_path))
    by_path[original_path] = (asset_id, checksum, name)

path_input = b''.join(p.encode('utf-8') + b'\0' for p in host_paths)
stat_run = run([
    'xargs', '-0', 'stat', '-c', '%s\t%n',
], input_bytes=path_input, timeout=600)

sizes = {}
stat_errors = []
for line in stat_run.stdout.decode('utf-8', 'replace').splitlines():
    size_text, _, file_path = line.partition('\t')
    try:
        sizes[to_container_path(file_path)] = int(size_text)
    except ValueError:
        stat_errors.append(line)
for line in stat_run.stderr.decode('utf-8', 'replace').splitlines():
    if line.strip():
        stat_errors.append(line.strip())

ordered_paths = sorted(paths, key=lambda p: (p not in sizes, sizes.get(p, 0), p))
ordered_input = b''.join(to_host_path(p).encode('utf-8') + b'\0' for p in ordered_paths)
hash_stdout = summary_json + '.hashes.tsv'
hash_stderr = summary_json + '.hashes.err'
with open(hash_stdout, 'wb') as out, open(hash_stderr, 'wb') as err:
    hash_run = subprocess.run([
        'xargs', '-0', '-n', '20', '-P', '2', 'sha1sum',
    ], input=ordered_input, stdout=out, stderr=err, check=False)

with open(hash_stdout, 'rb') as f:
    hash_text = f.read().decode('utf-8', 'replace')
with open(hash_stderr, 'rb') as f:
    hash_err = f.read().decode('utf-8', 'replace')

hashes = {}
hash_errors = []
for line in hash_text.splitlines():
    if len(line) < 43:
        continue
    checksum = line[:40].lower()
    file_path = to_container_path(line[42:])
    hashes[file_path] = checksum
for line in hash_err.splitlines():
    if line.strip():
        hash_errors.append(line.strip())

summary = {
    'input_csv': input_csv,
    'total_untracked_rows': len(rows),
    'unique_untracked_paths': len(set(paths)),
    'active_db_assets_with_checksum': asset_rows,
    'statted_paths': len(sizes),
    'stat_error_count': len(stat_errors),
    'total_statted_size_bytes': sum(sizes.values()),
    'hashed_paths': len(hashes),
    'hash_error_count': len(hash_errors),
    'prefix_counts': dict(prefix_counts),
    'extension_counts': dict(ext_counts),
    'exact_path_active_asset_matches': 0,
    'checksum_matches': 0,
    'filename_matches': 0,
    'checksum_and_filename_matches': 0,
    'unmatched': 0,
    'matches_csv': matches_csv,
    'unmatched_csv': unmatched_csv,
}

with open(matches_csv, 'w', newline='', encoding='utf-8') as fmatch, open(unmatched_csv, 'w', newline='', encoding='utf-8') as funmatched:
    match_fields = [
        'report_id', 'untracked_path', 'untracked_sha1', 'basename', 'exact_path_active_asset',
        'checksum_match_count', 'filename_match_count', 'sample_checksum_match_asset_id',
        'sample_checksum_match_path', 'sample_filename_match_asset_id', 'sample_filename_match_path',
    ]
    unmatch_fields = ['report_id', 'untracked_path', 'untracked_sha1', 'basename', 'reason']
    match_writer = csv.DictWriter(fmatch, fieldnames=match_fields)
    unmatch_writer = csv.DictWriter(funmatched, fieldnames=unmatch_fields)
    match_writer.writeheader()
    unmatch_writer.writeheader()

    for row in rows:
        report_id = row['id']
        file_path = row['path']
        basename = posixpath.basename(file_path).lower()
        checksum = hashes.get(file_path)
        exact = file_path in by_path
        checksum_hits = by_sha.get(checksum, []) if checksum else []
        filename_hits = by_name.get(basename, [])

        if exact:
            summary['exact_path_active_asset_matches'] += 1
        if checksum_hits:
            summary['checksum_matches'] += 1
        if filename_hits:
            summary['filename_matches'] += 1
        if checksum_hits and filename_hits:
            summary['checksum_and_filename_matches'] += 1

        if checksum_hits or filename_hits or exact:
            match_writer.writerow({
                'report_id': report_id,
                'untracked_path': file_path,
                'untracked_sha1': checksum or '',
                'basename': basename,
                'exact_path_active_asset': 'yes' if exact else 'no',
                'checksum_match_count': len(checksum_hits),
                'filename_match_count': len(filename_hits),
                'sample_checksum_match_asset_id': checksum_hits[0][0] if checksum_hits else '',
                'sample_checksum_match_path': checksum_hits[0][2] if checksum_hits else '',
                'sample_filename_match_asset_id': filename_hits[0][0] if filename_hits else '',
                'sample_filename_match_path': filename_hits[0][2] if filename_hits else '',
            })
        else:
            summary['unmatched'] += 1
            reason = 'hash_error_or_missing_file' if not checksum else 'no_active_asset_checksum_or_filename_match'
            unmatch_writer.writerow({
                'report_id': report_id,
                'untracked_path': file_path,
                'untracked_sha1': checksum or '',
                'basename': basename,
                'reason': reason,
            })

summary['sample_hash_errors'] = hash_errors[:25]
summary['sample_stat_errors'] = stat_errors[:25]
with open(summary_json, 'w', encoding='utf-8') as f:
    json.dump(summary, f, indent=2, sort_keys=True)
`;

async function main() {
  const args = process.argv.slice(2);
  const csvPath = argValue(args, "--csv", DEFAULT_CSV);
  if (!fs.existsSync(csvPath)) throw new Error(`CSV not found: ${csvPath}`);

  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const baseName = `immich-untracked-readonly-compare-${timestamp}`;
  const localPy = path.join("reports", `${baseName}.py`);
  const localSummary = path.join("reports", `${baseName}.summary.json`);
  const localMatches = path.join("reports", `${baseName}.matches.csv`);
  const localUnmatched = path.join("reports", `${baseName}.unmatched.csv`);
  const localReadme = path.join("reports", `${baseName}.summary.md`);
  const remoteDir = `/tmp/${baseName}`;
  const remotePy = `${remoteDir}/compare.py`;
  const remoteCsv = `${remoteDir}/remaining.csv`;
  const remoteSummary = `${remoteDir}/summary.json`;
  const remoteMatches = `${remoteDir}/matches.csv`;
  const remoteUnmatched = `${remoteDir}/unmatched.csv`;

  fs.mkdirSync("reports", { recursive: true });
  fs.writeFileSync(localPy, remotePython, { encoding: "utf8", mode: 0o600 });

  const apiKey = decryptApiKey(API_KEY_PATH);
  const { ws, call } = await connect(apiKey);
  try {
    await runCron(call, `mkdir -p ${remoteDir}`, "codex immich compare mkdir", 60);
    await uploadFile(apiKey, call, csvPath, remoteCsv, 0o600);
    await uploadFile(apiKey, call, localPy, remotePy, 0o700);
    await runCron(
      call,
      `python3 ${remotePy} ${remoteCsv} ${remoteSummary} ${remoteMatches} ${remoteUnmatched}`,
      "codex immich read-only checksum compare",
      28800,
    );
    await downloadFile(call, remoteSummary, localSummary);
    await downloadFile(call, remoteMatches, localMatches);
    await downloadFile(call, remoteUnmatched, localUnmatched);

    const summary = JSON.parse(fs.readFileSync(localSummary, "utf8"));
    const markdown = [
      "# Immich Untracked Read-Only Comparison",
      "",
      `Generated: ${new Date().toISOString()}`,
      "",
      `Input CSV: ${csvPath}`,
      "",
      `Total untracked rows: ${summary.total_untracked_rows}`,
      `Statted paths: ${summary.statted_paths}`,
      `Stat errors: ${summary.stat_error_count}`,
      `Total statted size bytes: ${summary.total_statted_size_bytes}`,
      `Hashed paths: ${summary.hashed_paths}`,
      `Hash errors: ${summary.hash_error_count}`,
      `Checksum matches: ${summary.checksum_matches}`,
      `Filename matches: ${summary.filename_matches}`,
      `Checksum and filename matches: ${summary.checksum_and_filename_matches}`,
      `Exact active asset path matches: ${summary.exact_path_active_asset_matches}`,
      `Unmatched: ${summary.unmatched}`,
      "",
      "Prefix counts:",
      ...Object.entries(summary.prefix_counts).map(([name, count]) => `- ${name}: ${count}`),
      "",
      "Extension counts:",
      ...Object.entries(summary.extension_counts).map(([name, count]) => `- ${name}: ${count}`),
      "",
      `Matches CSV: ${localMatches}`,
      `Unmatched CSV: ${localUnmatched}`,
      `Summary JSON: ${localSummary}`,
      "",
    ].join("\n");
    fs.writeFileSync(localReadme, markdown, "utf8");

    console.log(JSON.stringify({ localSummary, localMatches, localUnmatched, localReadme, summary }, null, 2));
  } finally {
    ws.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
