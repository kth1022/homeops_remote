#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const TRUENAS_URL = "https://192.168.1.34";
const TRUENAS_WSS = "wss://192.168.1.34/api/current";
const API_KEY_PATH = "config/truenas.codex.api-key.xml";

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
  if (result.status !== 0) throw new Error(result.stderr.trim() || String(result.error) || "Failed to decrypt TrueNAS API key.");
  const key = result.stdout.trim();
  if (!key) throw new Error("TrueNAS API key file decrypted to an empty value.");
  return key;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function waitJob(call, jobId, timeoutSec = 180) {
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

async function uploadText(apiKey, call, text, remotePath, mode = 0o755) {
  const form = new FormData();
  form.append("data", JSON.stringify({ method: "filesystem.put", params: [remotePath, { append: false, mode }] }));
  form.append("file", new Blob([text], { type: "text/plain" }), path.basename(remotePath));
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

async function downloadText(call, remotePath, localPath) {
  const [jobId, url] = await call("core.download", ["filesystem.get", [remotePath], path.basename(localPath), true]);
  const response = await fetch(`${TRUENAS_URL}${url}`);
  if (!response.ok) throw new Error(`TrueNAS download failed with HTTP ${response.status}.`);
  const text = await response.text();
  fs.writeFileSync(localPath, text, "utf8");
  await waitJob(call, jobId, 120);
  return text;
}

const remotePython = String.raw`
import json
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

base = "http://127.0.0.1:32400"
client_id = "codex-hw-test"
pref = "/mnt/Plex/AppData/PlexServer/PlexConfig/Library/Application Support/Plex Media Server/Preferences.xml"
root = ET.parse(pref).getroot()
token = root.attrib.get("PlexOnlineToken") or ""
print("token_present=" + str(bool(token)))
print("HardwareAcceleratedCodecs=" + str(root.attrib.get("HardwareAcceleratedCodecs")))
print("HardwareDevicePath=" + str(root.attrib.get("HardwareDevicePath")))

client_headers = {
    "X-Plex-Client-Identifier": client_id,
    "X-Plex-Product": "Codex Hardware Transcode Test",
    "X-Plex-Version": "1.0",
    "X-Plex-Platform": "Linux",
    "X-Plex-Device": "TrueNAS",
    "X-Plex-Device-Name": "TrueNAS Codex Test",
}

def fetch(api_path, timeout=30):
    sep = "&" if "?" in api_path else "?"
    url = base + api_path + sep + urllib.parse.urlencode({"X-Plex-Token": token})
    req = urllib.request.Request(url, headers=client_headers)
    return urllib.request.urlopen(req, timeout=timeout).read()

def parse(api_path):
    return ET.fromstring(fetch(api_path))

sections = parse("/library/sections")
print("sections=" + ",".join([d.attrib.get("title", "?") + ":" + d.attrib.get("type", "?") for d in sections.findall("Directory")]))

item = None
for directory in sections.findall("Directory"):
    key = directory.attrib.get("key")
    library_type = directory.attrib.get("type")
    candidate_types = ["1"] if library_type == "movie" else ["4"] if library_type == "show" else []
    for media_type in candidate_types:
        try:
            media = parse("/library/sections/%s/all?type=%s&sort=addedAt:desc" % (key, media_type))
        except Exception as exc:
            print("section_query_failed=" + repr(exc))
            continue
        for video in media.findall(".//Video"):
            if video.find("Media/Part") is not None and video.attrib.get("ratingKey"):
                item = video
                break
        if item is not None:
            break
    if item is not None:
        break

if item is None:
    raise SystemExit("no_video_item_found")

rating_key = item.attrib["ratingKey"]
print("selected_ratingKey=" + rating_key)
print("selected_type=" + str(item.attrib.get("type")))
print("selected_title=" + str(item.attrib.get("title") or item.attrib.get("grandparentTitle") or ""))
media = item.find("Media")
part = item.find("Media/Part")
if media is not None:
    print("selected_media=" + json.dumps(media.attrib, sort_keys=True))
if part is not None:
    part_attrs = dict(part.attrib)
    if part_attrs.get("file"):
        part_attrs["file"] = "[present]"
    print("selected_part=" + json.dumps(part_attrs, sort_keys=True))

params = {
    "mediaIndex": "0",
    "partIndex": "0",
    "protocol": "hls",
    "fastSeek": "1",
    "directPlay": "0",
    "directStream": "0",
    "subtitleSize": "100",
    "audioBoost": "100",
    "location": "lan",
    "session": client_id + "-" + str(int(time.time())),
    "offset": "0",
    "videoResolution": "1280x720",
    "maxVideoBitrate": "2000",
    "videoQuality": "40",
    "X-Plex-Token": token,
    "X-Plex-Client-Identifier": client_id,
    "X-Plex-Product": "Codex Hardware Transcode Test",
    "X-Plex-Version": "1.0",
    "X-Plex-Platform": "Linux",
    "X-Plex-Device": "TrueNAS",
    "X-Plex-Device-Name": "TrueNAS Codex Test",
}

path_variants = [
    "/library/metadata/" + rating_key,
    base + "/library/metadata/" + rating_key,
    base + "/library/metadata/" + rating_key + "?" + urllib.parse.urlencode({"X-Plex-Token": token}),
]

started = False
for idx, media_path in enumerate(path_variants, start=1):
    attempt_params = dict(params)
    attempt_params["path"] = media_path
    print("path_variant=%s" % idx)
    decision_url = base + "/video/:/transcode/universal/decision?" + urllib.parse.urlencode(attempt_params)
    try:
        decision = urllib.request.urlopen(urllib.request.Request(decision_url, headers=client_headers), timeout=45).read(8192).decode("utf-8", "replace")
        print("transcode_decision_ok=true")
        print("decision_head=" + decision[:800].replace(token, "[TOKEN]").replace("\n", "\\n"))
    except urllib.error.HTTPError as exc:
        body = exc.read(2048).decode("utf-8", "replace")
        print("transcode_decision_ok=false")
        print("transcode_decision_error=http_%s %s %s" % (exc.code, exc.reason, body.replace(token, "[TOKEN]").replace("\n", "\\n")))
    except Exception as exc:
        print("transcode_decision_ok=false")
        print("transcode_decision_error=" + repr(exc))

    url = base + "/video/:/transcode/universal/start.m3u8?" + urllib.parse.urlencode(attempt_params)
    try:
        playlist = urllib.request.urlopen(urllib.request.Request(url, headers=client_headers), timeout=45).read(8192).decode("utf-8", "replace")
        print("transcode_start_ok=true")
        print("playlist_head=" + playlist[:400].replace(token, "[TOKEN]").replace("\n", "\\n"))
        started = True
        break
    except urllib.error.HTTPError as exc:
        body = exc.read(2048).decode("utf-8", "replace")
        print("transcode_start_ok=false")
        print("transcode_start_error=http_%s %s %s" % (exc.code, exc.reason, body.replace(token, "[TOKEN]").replace("\n", "\\n")))
    except Exception as exc:
        print("transcode_start_ok=false")
        print("transcode_start_error=" + repr(exc))

time.sleep(8)
try:
    sessions = parse("/status/sessions")
    print("session_count=" + str(sessions.attrib.get("size")))
    for video in sessions.findall(".//Video"):
        transcode = video.find("TranscodeSession")
        print("session_video=" + json.dumps({
            "title": video.attrib.get("title") or video.attrib.get("grandparentTitle"),
            "ratingKey": video.attrib.get("ratingKey"),
            "state": video.attrib.get("state"),
            "transcode": transcode.attrib if transcode is not None else None,
        }, sort_keys=True))
except Exception as exc:
    print("sessions_error=" + repr(exc))

cid = subprocess.check_output(
    "docker ps --filter label=com.docker.compose.project=ix-plex --filter label=com.docker.compose.service=plex -q | head -n1",
    shell=True,
    text=True,
).strip()
print("cid=" + cid[:12])
print("nvidia_smi_after_request=")
subprocess.run(["docker", "exec", cid, "nvidia-smi"], check=False)
`;

async function main() {
  const apiKey = decryptApiKey(API_KEY_PATH);
  const { ws, call } = await connect(apiKey);
  try {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z");
    const remoteScript = `/tmp/plex-hw-transcode-test-${stamp}.py`;
    const remoteOut = `/tmp/plex-hw-transcode-test-${stamp}.txt`;
    const localOut = path.join("reports", `plex-hw-transcode-test-${stamp}.txt`);

    await uploadText(apiKey, call, remotePython, remoteScript, 0o755);
    const cron = await call("cronjob.create", [
      { enabled: false, stdout: false, stderr: false, command: `python3 '${remoteScript}' > '${remoteOut}' 2>&1`, description: "codex plex hardware transcode test", user: "root" },
    ]);
    try {
      const jobId = await call("cronjob.run", [cron.id, false]);
      await waitJob(call, jobId, 180);
    } finally {
      try {
        await call("cronjob.delete", [cron.id]);
      } catch {
        // Best-effort cleanup of the temporary cron definition.
      }
    }

    const text = await downloadText(call, remoteOut, localOut);
    console.log(localOut);
    console.log(text);
  } finally {
    ws.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
