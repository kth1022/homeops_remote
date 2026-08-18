#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { createHash } = require("crypto");
const { spawnSync } = require("child_process");

const DEFAULT_TRUENAS_URL = "https://192.168.1.34";
const DEFAULT_TRUENAS_WSS = "wss://192.168.1.34/api/current";
const DEFAULT_API_KEY_PATH = "config/truenas.codex.api-key.xml";
const DEFAULT_PLEX_URL = "http://192.168.1.34:32400";
const DEFAULT_PREFERENCES_PATH = "/mnt/Plex/AppData/PlexServer/PlexConfig/Library/Application Support/Plex Media Server/Preferences.xml";
const DEFAULT_DECISIONS_PATH = "logs/plex-duplicate-decisions.json";

function usage() {
  return `
Usage:
  node scripts/Find-PlexDuplicateMovies.js [options]

Read-only Plex duplicate movie report. It does not delete, move, rename, or edit media.

Options:
  --plex-url <url>              Plex base URL. Default: ${DEFAULT_PLEX_URL}
  --plex-token <token>          Plex token. Prefer PLEX_TOKEN or token file when possible.
  --plex-token-file <path>      File containing a Plex token.
  --library <name-or-key>       Limit scan to one movie library title or key.
  --out-dir <path>              Output directory. Default: reports
  --page-size <number>          Plex API page size. Default: 500
  --api-key-path <path>         TrueNAS API key XML. Default: ${DEFAULT_API_KEY_PATH}
  --truenas-url <url>           TrueNAS HTTPS URL. Default: ${DEFAULT_TRUENAS_URL}
  --truenas-wss <url>           TrueNAS WSS API URL. Default: ${DEFAULT_TRUENAS_WSS}
  --preferences-path <path>     Plex Preferences.xml path on TrueNAS.
  --decisions-path <path>       Local approve/ignore decision store. Default: ${DEFAULT_DECISIONS_PATH}
  --help                        Show this help.

Default token source order:
  1. --plex-token
  2. PLEX_TOKEN environment variable
  3. --plex-token-file
  4. TrueNAS read-only download of Plex Preferences.xml
`.trim();
}

function argValue(args, name, fallback = "") {
  const idx = args.indexOf(name);
  if (idx === -1) return fallback;
  if (idx === args.length - 1) throw new Error(`Missing value for ${name}`);
  return args[idx + 1];
}

function hasFlag(args, name) {
  return args.includes(name);
}

function parseArgs(argv) {
  if (hasFlag(argv, "--help") || hasFlag(argv, "-h")) {
    console.log(usage());
    process.exit(0);
  }
  const pageSize = Number(argValue(argv, "--page-size", "500"));
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 2000) {
    throw new Error("--page-size must be an integer between 1 and 2000.");
  }
  return {
    plexUrl: argValue(argv, "--plex-url", DEFAULT_PLEX_URL).replace(/\/+$/, ""),
    plexToken: argValue(argv, "--plex-token", process.env.PLEX_TOKEN || ""),
    plexTokenFile: argValue(argv, "--plex-token-file", ""),
    library: argValue(argv, "--library", ""),
    outDir: argValue(argv, "--out-dir", "reports"),
    pageSize,
    apiKeyPath: argValue(argv, "--api-key-path", DEFAULT_API_KEY_PATH),
    truenasUrl: argValue(argv, "--truenas-url", DEFAULT_TRUENAS_URL).replace(/\/+$/, ""),
    truenasWss: argValue(argv, "--truenas-wss", DEFAULT_TRUENAS_WSS),
    preferencesPath: argValue(argv, "--preferences-path", DEFAULT_PREFERENCES_PATH),
    decisionsPath: argValue(argv, "--decisions-path", DEFAULT_DECISIONS_PATH),
  };
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
  if (result.status !== 0) throw new Error(result.stderr.trim() || String(result.error) || "Failed to decrypt TrueNAS API key.");
  const key = result.stdout.trim();
  if (!key) throw new Error("TrueNAS API key file decrypted to an empty value.");
  return key;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function connectTrueNas(apiKey, options) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  const ws = new WebSocket(options.truenasWss, { headers: { Origin: options.truenasUrl } });
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

async function waitJob(call, jobId, timeoutSec = 120) {
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

async function downloadTrueNasText(call, remotePath, options) {
  const [jobId, url] = await call("core.download", ["filesystem.get", [remotePath], path.basename(remotePath), true]);
  const response = await fetch(`${options.truenasUrl}${url}`);
  if (!response.ok) throw new Error(`TrueNAS download failed with HTTP ${response.status}.`);
  const text = await response.text();
  await waitJob(call, jobId, 120);
  return text;
}

function decodeXmlAttribute(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function extractPlexToken(preferencesXml) {
  const match = /\bPlexOnlineToken="([^"]*)"/.exec(preferencesXml);
  const token = match ? decodeXmlAttribute(match[1]).trim() : "";
  if (!token) throw new Error("PlexOnlineToken was not found in Plex Preferences.xml.");
  return token;
}

async function resolvePlexToken(options) {
  if (options.plexToken) return options.plexToken.trim();
  if (options.plexTokenFile) {
    const token = fs.readFileSync(options.plexTokenFile, "utf8").trim();
    if (!token) throw new Error(`Plex token file is empty: ${options.plexTokenFile}`);
    return token;
  }

  const apiKey = decryptApiKey(options.apiKeyPath);
  const { ws, call } = await connectTrueNas(apiKey, options);
  try {
    const preferencesXml = await downloadTrueNasText(call, options.preferencesPath, options);
    return extractPlexToken(preferencesXml);
  } finally {
    ws.close();
  }
}

function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

async function plexJson(apiPath, token, options, extraParams = {}, extraHeaders = {}) {
  const url = new URL(`${options.plexUrl}${apiPath}`);
  for (const [key, value] of Object.entries(extraParams)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  url.searchParams.set("X-Plex-Token", token);
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "X-Plex-Accept": "application/json",
      "X-Plex-Client-Identifier": "homeops-plex-duplicate-scanner",
      "X-Plex-Product": "HomeOps Plex Duplicate Scanner",
      "X-Plex-Version": "1.0",
      ...extraHeaders,
    },
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Plex API ${apiPath} failed with HTTP ${response.status}: ${body.slice(0, 300)}`);
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`Plex API ${apiPath} did not return JSON. Response started with: ${body.slice(0, 120)}`);
  }
}

async function listMovieSections(token, options) {
  const sections = await plexJson("/library/sections", token, options);
  return toArray(sections.MediaContainer?.Directory)
    .filter((section) => section.type === "movie")
    .filter((section) => {
      if (!options.library) return true;
      const wanted = options.library.toLowerCase();
      return String(section.key || "").toLowerCase() === wanted || String(section.title || "").toLowerCase() === wanted;
    })
    .map((section) => ({
      key: String(section.key),
      title: section.title || `Movie Library ${section.key}`,
      type: section.type,
    }));
}

async function listMoviesInSection(section, token, options) {
  const movies = [];
  let start = 0;
  let totalSize = null;

  for (;;) {
    const page = await plexJson(
      `/library/sections/${encodeURIComponent(section.key)}/all`,
      token,
      options,
      {
        type: 1,
        includeGuids: 1,
        sort: "titleSort",
        "X-Plex-Container-Start": start,
        "X-Plex-Container-Size": options.pageSize,
      },
      {
        "X-Plex-Container-Start": String(start),
        "X-Plex-Container-Size": String(options.pageSize),
      },
    );
    const container = page.MediaContainer || {};
    const pageMovies = toArray(container.Metadata);
    movies.push(...pageMovies.map((movie) => ({ ...movie, _sectionKey: section.key, _sectionTitle: section.title })));
    totalSize = Number(container.totalSize || container.size || totalSize || movies.length);
    if (pageMovies.length === 0 || movies.length >= totalSize || pageMovies.length < options.pageSize) break;
    start += pageMovies.length;
  }

  return movies;
}

function normalizeTitle(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeGuid(guid) {
  const raw = String(guid || "").trim().toLowerCase();
  if (!raw) return "";
  const external = raw.match(/(imdb:\/\/tt\d+|tmdb:\/\/\d+|tvdb:\/\/\d+)/);
  if (external) return external[1];
  if (raw.startsWith("plex://movie/")) return raw.split("?")[0];
  if (raw.startsWith("com.plexapp.agents.")) {
    const parts = raw.split("://");
    if (parts.length > 1) return parts.slice(1).join("://").split("?")[0];
  }
  return raw.split("?")[0];
}

function movieYear(movie) {
  if (movie.year) return String(movie.year);
  if (movie.originallyAvailableAt) return String(movie.originallyAvailableAt).slice(0, 4);
  return "";
}

function keysForMovie(movie) {
  const guidValues = [
    movie.guid,
    ...toArray(movie.Guid).map((guid) => guid.id),
  ].map(normalizeGuid).filter(Boolean);

  const external = [...new Set(guidValues.filter((guid) => /^(imdb|tmdb|tvdb):\/\//.test(guid)))];
  if (external.length > 0) return external.map((guid) => `guid:${guid}`);

  const plex = [...new Set(guidValues.filter((guid) => guid.startsWith("plex://movie/")))];
  if (plex.length > 0) return plex.map((guid) => `guid:${guid}`);

  return [`title:${normalizeTitle(movie.title)}:${movieYear(movie)}`];
}

function getResolutionHeight(media) {
  const resolution = String(media.videoResolution || "").toLowerCase();
  if (resolution.includes("4k") || resolution.includes("2160")) return 2160;
  if (resolution.includes("1080")) return 1080;
  if (resolution.includes("720")) return 720;
  if (resolution.includes("576")) return 576;
  if (resolution.includes("480") || resolution.includes("sd")) return 480;
  const height = Number(media.height || 0);
  if (height) return height;
  const width = Number(media.width || 0);
  if (width >= 3800) return 2160;
  if (width >= 1900) return 1080;
  if (width >= 1200) return 720;
  return 0;
}

function dynamicRangeScore(media) {
  const value = String(media.videoDynamicRange || "").toLowerCase();
  if (value.includes("dolby") || value.includes("vision") || /\bdv\b/.test(value)) return 350;
  if (value.includes("hdr10")) return 260;
  if (value.includes("hdr")) return 220;
  return 0;
}

function codecScore(media) {
  const codec = String(media.videoCodec || "").toLowerCase();
  if (codec.includes("av1")) return 90;
  if (codec.includes("hevc") || codec.includes("h265") || codec.includes("h.265")) return 80;
  if (codec.includes("h264") || codec.includes("h.264") || codec.includes("avc")) return 55;
  if (codec.includes("mpeg4")) return 25;
  if (codec.includes("mpeg2")) return 15;
  return 0;
}

function versionSize(version) {
  return version.parts.reduce((sum, part) => sum + Number(part.size || 0), 0);
}

function addedAtScore(movie) {
  const added = Number(movie.addedAt || 0);
  if (!added) return 0;
  return Math.min(50, Math.max(0, added / 100000000));
}

function versionScore(version) {
  const media = version.media;
  const height = getResolutionHeight(media);
  const bitrate = Number(media.bitrate || 0);
  const audioChannels = Number(media.audioChannels || 0);
  const sizeGb = versionSize(version) / 1024 / 1024 / 1024;
  return Math.round(
    height * 10
    + dynamicRangeScore(media)
    + codecScore(media)
    + Math.min(900, bitrate / 100)
    + Math.min(90, audioChannels * 12)
    + Math.min(80, sizeGb)
    + addedAtScore(version.movie),
  );
}

function qualityLabel(version) {
  const media = version.media;
  const parts = version.parts;
  const height = getResolutionHeight(media);
  const bits = [];
  if (height) bits.push(`${height}p`);
  if (media.videoDynamicRange) bits.push(media.videoDynamicRange);
  if (media.videoCodec) bits.push(media.videoCodec);
  if (media.bitrate) bits.push(`${media.bitrate} kbps`);
  if (media.audioCodec) bits.push(media.audioCodec);
  if (media.audioChannels) bits.push(`${media.audioChannels}ch`);
  const size = versionSize({ parts });
  if (size) bits.push(formatBytes(size));
  return bits.join(" / ") || "unknown quality";
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!value) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let scaled = value;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return `${scaled.toFixed(unit >= 3 ? 2 : 1)} ${units[unit]}`;
}

function filesForVersion(version) {
  return version.parts.map((part) => part.file).filter(Boolean);
}

function hashText(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex").slice(0, 20);
}

function sortedUnique(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))].sort();
}

function groupFiles(group) {
  return sortedUnique(group.versions.flatMap((version) => filesForVersion(version)));
}

function groupFingerprint(group) {
  return hashText(groupFiles(group).join("\n"));
}

function pairFingerprintForFiles(keepFiles, candidateFiles) {
  return hashText([
    "keep",
    ...sortedUnique(keepFiles),
    "candidate",
    ...sortedUnique(candidateFiles),
  ].join("\n"));
}

function candidatePairFingerprint(group, candidate) {
  return pairFingerprintForFiles(filesForVersion(group.keep), filesForVersion(candidate));
}

function candidateRowId(group, keep, candidate) {
  return hashText([
    ...sortedUnique(group.keys),
    "keep",
    ...sortedUnique(filesForVersion(keep)),
    "candidate",
    ...sortedUnique(filesForVersion(candidate)),
  ].join("\n"));
}

function candidateDecisionKey(group, candidate) {
  return candidateRowId(group, group.keep, candidate);
}

function loadDecisions(decisionsPath) {
  if (!decisionsPath || !fs.existsSync(decisionsPath)) return { version: 1, decisions: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(decisionsPath, "utf8"));
    return {
      version: parsed.version || 1,
      decisions: parsed.decisions && typeof parsed.decisions === "object" ? parsed.decisions : {},
    };
  } catch (error) {
    throw new Error(`Failed to read Plex duplicate decisions at ${decisionsPath}: ${error.message}`);
  }
}

function ignoredDecisionFor(group, candidate, decisions) {
  const rowId = candidateDecisionKey(group, candidate);
  const pairFingerprint = candidatePairFingerprint(group, candidate);
  const decision = decisions.decisions?.[rowId] || Object.values(decisions.decisions || {}).find((entry) => (
    entry?.action === "ignored" && entry.pairFingerprint === pairFingerprint
  ));
  if (!decision || decision.action !== "ignored") return null;
  if (decision.pairFingerprint) {
    if (decision.pairFingerprint !== pairFingerprint) return null;
  } else {
    const storedPairFingerprint = pairFingerprintForFiles(decision.keepFiles || [], decision.candidateFiles || []);
    if (storedPairFingerprint !== pairFingerprint) return null;
  }
  return decision;
}

function applyIgnoredDecisions(groups, decisions) {
  let ignoredCandidatesSkipped = 0;
  const visibleGroups = groups
    .map((group) => {
      const candidates = group.candidates.filter((candidate) => {
        const ignored = ignoredDecisionFor(group, candidate, decisions);
        if (ignored) ignoredCandidatesSkipped += 1;
        return !ignored;
      });
      return { ...group, candidates };
    })
    .filter((group) => group.candidates.length > 0);
  return { groups: visibleGroups, ignoredCandidatesSkipped };
}

function compareReason(keep, candidate) {
  const reasons = [];
  const keepHeight = getResolutionHeight(keep.media);
  const candidateHeight = getResolutionHeight(candidate.media);
  if (keepHeight > candidateHeight) reasons.push(`higher resolution (${keepHeight || "unknown"}p vs ${candidateHeight || "unknown"}p)`);

  const keepDynamic = dynamicRangeScore(keep.media);
  const candidateDynamic = dynamicRangeScore(candidate.media);
  if (keepDynamic > candidateDynamic) reasons.push("better HDR/dynamic range metadata");

  const keepBitrate = Number(keep.media.bitrate || 0);
  const candidateBitrate = Number(candidate.media.bitrate || 0);
  if (keepBitrate && candidateBitrate && keepBitrate > candidateBitrate * 1.15) reasons.push("higher bitrate");

  const keepCodec = codecScore(keep.media);
  const candidateCodec = codecScore(candidate.media);
  if (keepCodec > candidateCodec) reasons.push(`preferred video codec (${keep.media.videoCodec || "unknown"} vs ${candidate.media.videoCodec || "unknown"})`);

  const keepAdded = Number(keep.movie.addedAt || 0);
  const candidateAdded = Number(candidate.movie.addedAt || 0);
  if (keepAdded && candidateAdded && keepAdded > candidateAdded) reasons.push("newer Plex added date");

  return reasons.length > 0 ? reasons.join("; ") : "lower overall quality score";
}

function confidenceFor(group, keep, candidate, keyTypes) {
  const editions = [...new Set(group.versions.map((version) => version.editionTitle).filter(Boolean))];
  if (editions.length > 1) return "manual-review: mixed editions";
  if (!keyTypes.externalGuid) return "manual-review: title/year match only";
  if (keep.score - candidate.score < 120) return "manual-review: similar quality";
  return "remove-candidate";
}

function collectVersions(movie) {
  const mediaItems = toArray(movie.Media);
  return mediaItems.map((media, index) => {
    const parts = toArray(media.Part).map((part) => ({
      id: part.id || "",
      key: part.key || "",
      file: part.file || "",
      size: Number(part.size || 0),
      container: part.container || "",
      duration: Number(part.duration || media.duration || movie.duration || 0),
      indexes: part.indexes || "",
      accessible: part.accessible,
      exists: part.exists,
    }));
    const version = {
      id: `${movie.ratingKey || "movie"}:${media.id || index}`,
      movie: {
        ratingKey: movie.ratingKey || "",
        title: movie.title || "",
        year: movieYear(movie),
        guid: movie.guid || "",
        library: movie._sectionTitle || "",
        sectionKey: movie._sectionKey || "",
        addedAt: movie.addedAt || "",
        updatedAt: movie.updatedAt || "",
        originallyAvailableAt: movie.originallyAvailableAt || "",
      },
      mediaIndex: index,
      media: {
        id: media.id || "",
        videoResolution: media.videoResolution || "",
        videoDynamicRange: media.videoDynamicRange || "",
        videoCodec: media.videoCodec || "",
        videoProfile: media.videoProfile || "",
        audioCodec: media.audioCodec || "",
        audioChannels: media.audioChannels || "",
        bitrate: media.bitrate || "",
        width: media.width || "",
        height: media.height || "",
        container: media.container || "",
        duration: media.duration || movie.duration || "",
      },
      editionTitle: movie.editionTitle || media.editionTitle || "",
      parts,
    };
    version.score = versionScore(version);
    version.quality = qualityLabel(version);
    return version;
  }).filter((version) => version.parts.length > 0);
}

function buildDuplicateGroups(movies) {
  const parent = new Map();
  const movieKeys = new Map();

  function find(key) {
    if (!parent.has(key)) parent.set(key, key);
    const p = parent.get(key);
    if (p === key) return key;
    const root = find(p);
    parent.set(key, root);
    return root;
  }

  function union(a, b) {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootB, rootA);
  }

  for (const movie of movies) {
    const keys = keysForMovie(movie);
    movieKeys.set(movie, keys);
    keys.forEach((key) => find(key));
    keys.slice(1).forEach((key) => union(keys[0], key));
  }

  const groups = new Map();
  for (const movie of movies) {
    const keys = movieKeys.get(movie);
    const root = find(keys[0]);
    if (!groups.has(root)) groups.set(root, { key: root, keys: new Set(), movies: [], versions: [] });
    const group = groups.get(root);
    keys.forEach((key) => group.keys.add(key));
    group.movies.push(movie);
    group.versions.push(...collectVersions(movie));
  }

  return [...groups.values()]
    .map((group) => {
      group.keys = [...group.keys].sort();
      group.versions.sort((a, b) => b.score - a.score);
      group.keep = group.versions[0] || null;
      group.candidates = group.versions.slice(1);
      const titles = group.movies.map((movie) => `${movie.title || "Untitled"}${movieYear(movie) ? ` (${movieYear(movie)})` : ""}`);
      group.title = mostCommon(titles) || titles[0] || group.key;
      group.keyTypes = {
        externalGuid: group.keys.some((key) => /^guid:(imdb|tmdb|tvdb):\/\//.test(key)),
      };
      return group;
    })
    .filter((group) => group.versions.length > 1)
    .sort((a, b) => a.title.localeCompare(b.title));
}

function mostCommon(values) {
  const counts = new Map();
  for (const value of values.filter(Boolean)) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || "";
}

function csvCell(value) {
  const text = String(value ?? "");
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fileStamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function writeReports({ generatedAt, options, sections, movies, groups, ignoredCandidatesSkipped }) {
  fs.mkdirSync(options.outDir, { recursive: true });
  const stamp = fileStamp(new Date(generatedAt));
  const base = path.join(options.outDir, `plex-duplicate-movies-${stamp}`);
  const latestBase = path.join(options.outDir, "plex-duplicate-movies-latest");

  const rows = [];
  groups.forEach((group, groupIndex) => {
    group.candidates.forEach((candidate) => {
      const rowId = candidateDecisionKey(group, candidate);
      const fingerprint = groupFingerprint(group);
      const pairFingerprint = candidatePairFingerprint(group, candidate);
      rows.push({
        rowId,
        groupFingerprint: fingerprint,
        pairFingerprint,
        group: groupIndex + 1,
        title: group.title,
        library: group.keep.movie.library,
        keepQuality: group.keep.quality,
        keepScore: group.keep.score,
        keepFiles: filesForVersion(group.keep).join(" | "),
        candidateQuality: candidate.quality,
        candidateScore: candidate.score,
        candidateFiles: filesForVersion(candidate).join(" | "),
        confidence: confidenceFor(group, group.keep, candidate, group.keyTypes),
        reason: compareReason(group.keep, candidate),
      });
    });
  });

  const json = {
    generatedAt,
    safety: "read-only report; no files were deleted, moved, renamed, or edited",
    source: {
      plexUrl: options.plexUrl,
      libraryFilter: options.library || null,
      tokenSource: options.plexToken || options.plexTokenFile ? "explicit token" : "TrueNAS Plex Preferences.xml",
    },
    summary: {
      movieLibrariesScanned: sections.length,
      moviesScanned: movies.length,
      duplicateGroups: groups.length,
      removeCandidates: rows.length,
      ignoredCandidatesSkipped,
    },
    sections,
    groups: groups.map((group, index) => ({
      index: index + 1,
      title: group.title,
      keys: group.keys,
      groupFingerprint: groupFingerprint(group),
      groupFiles: groupFiles(group),
      keep: group.keep,
      candidates: group.candidates.map((candidate) => ({
        ...candidate,
        rowId: candidateDecisionKey(group, candidate),
        groupFingerprint: groupFingerprint(group),
        pairFingerprint: candidatePairFingerprint(group, candidate),
        confidence: confidenceFor(group, group.keep, candidate, group.keyTypes),
        reason: compareReason(group.keep, candidate),
      })),
    })),
  };

  const csvHeader = [
    "group",
    "row_id",
    "group_fingerprint",
    "title",
    "library",
    "keep_quality",
    "keep_score",
    "keep_files",
    "candidate_quality",
    "candidate_score",
    "candidate_files",
    "confidence",
    "reason",
  ];
  const csv = [
    csvHeader.join(","),
    ...rows.map((row) => csvHeader.map((key) => csvCell(row[key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] ?? row[key])).join(",")),
  ].join("\n") + "\n";

  const mdLines = [
    "# Plex Duplicate Movies Report",
    "",
    `Generated: ${generatedAt}`,
    "",
    "Safety: read-only report. No files were deleted, moved, renamed, or edited.",
    "",
    "## Summary",
    "",
    `- Movie libraries scanned: ${sections.length}`,
    `- Movies scanned: ${movies.length}`,
    `- Duplicate groups found: ${groups.length}`,
    `- Remove candidates listed: ${rows.length}`,
    `- Ignored candidates skipped: ${ignoredCandidatesSkipped}`,
    "",
    "## Candidate Table",
    "",
    "| # | Title | Keep | Remove candidate | Confidence | Reason |",
    "|---|---|---|---|---|---|",
  ];
  if (rows.length === 0) {
    mdLines.push("| - | No duplicate movie versions found | - | - | - | - |");
  } else {
    rows.forEach((row) => {
      mdLines.push(`| ${row.group} | ${escapeMarkdown(row.title)} | ${escapeMarkdown(row.keepQuality)} | ${escapeMarkdown(row.candidateQuality)} | ${escapeMarkdown(row.confidence)} | ${escapeMarkdown(row.reason)} |`);
    });
  }
  mdLines.push("", "## Details", "");
  groups.forEach((group, index) => {
    mdLines.push(`### ${index + 1}. ${group.title}`, "");
    mdLines.push(`Keep candidate: ${group.keep.quality} (score ${group.keep.score})`);
    filesForVersion(group.keep).forEach((file) => mdLines.push(`- KEEP: \`${file}\``));
    group.candidates.forEach((candidate) => {
      mdLines.push("");
      mdLines.push(`Remove candidate: ${candidate.quality} (score ${candidate.score})`);
      mdLines.push(`Confidence: ${confidenceFor(group, group.keep, candidate, group.keyTypes)}`);
      mdLines.push(`Reason: ${compareReason(group.keep, candidate)}`);
      filesForVersion(candidate).forEach((file) => mdLines.push(`- REMOVE CANDIDATE: \`${file}\``));
    });
    mdLines.push("");
  });

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Plex Duplicate Movies Report</title>
  <style>
    body { margin: 0; font-family: Segoe UI, Arial, sans-serif; background: #f7f7f4; color: #1e2328; }
    main { max-width: 1180px; margin: 0 auto; padding: 28px 20px 48px; }
    h1 { font-size: 28px; margin: 0 0 8px; }
    h2 { font-size: 20px; margin: 28px 0 12px; }
    h3 { font-size: 17px; margin: 24px 0 8px; }
    .muted { color: #59636e; }
    .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; margin: 18px 0; }
    .metric { background: #fff; border: 1px solid #d9ddd7; border-radius: 8px; padding: 12px; }
    .metric strong { display: block; font-size: 24px; }
    table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #d9ddd7; }
    th, td { padding: 9px 10px; border-bottom: 1px solid #e5e7e2; text-align: left; vertical-align: top; font-size: 13px; }
    th { background: #eef1ec; font-size: 12px; text-transform: uppercase; color: #3d474f; }
    code { overflow-wrap: anywhere; word-break: break-word; }
    .group { border-top: 1px solid #d9ddd7; padding-top: 14px; }
    .keep { color: #0d5f3c; font-weight: 600; }
    .candidate { color: #9a3412; font-weight: 600; }
    .file { background: #fff; border: 1px solid #e1e4df; border-radius: 6px; padding: 7px 9px; margin: 6px 0; }
  </style>
</head>
<body>
<main>
  <h1>Plex Duplicate Movies Report</h1>
  <p class="muted">Generated ${escapeHtml(generatedAt)}. Read-only report: no files were deleted, moved, renamed, or edited.</p>
  <section class="summary">
    <div class="metric"><strong>${sections.length}</strong> movie libraries</div>
    <div class="metric"><strong>${movies.length}</strong> movies scanned</div>
    <div class="metric"><strong>${groups.length}</strong> duplicate groups</div>
    <div class="metric"><strong>${rows.length}</strong> remove candidates</div>
    <div class="metric"><strong>${ignoredCandidatesSkipped}</strong> ignored skipped</div>
  </section>
  <h2>Candidate Table</h2>
  <table>
    <thead><tr><th>#</th><th>Title</th><th>Keep</th><th>Remove Candidate</th><th>Confidence</th><th>Reason</th></tr></thead>
    <tbody>
      ${rows.length ? rows.map((row) => `<tr><td>${row.group}</td><td>${escapeHtml(row.title)}</td><td>${escapeHtml(row.keepQuality)}</td><td>${escapeHtml(row.candidateQuality)}</td><td>${escapeHtml(row.confidence)}</td><td>${escapeHtml(row.reason)}</td></tr>`).join("\n") : '<tr><td colspan="6">No duplicate movie versions found.</td></tr>'}
    </tbody>
  </table>
  <h2>Details</h2>
  ${groups.map((group, index) => `
    <section class="group">
      <h3>${index + 1}. ${escapeHtml(group.title)}</h3>
      <p><span class="keep">Keep candidate:</span> ${escapeHtml(group.keep.quality)} (score ${group.keep.score})</p>
      ${filesForVersion(group.keep).map((file) => `<div class="file"><code>KEEP: ${escapeHtml(file)}</code></div>`).join("")}
      ${group.candidates.map((candidate) => `
        <p><span class="candidate">Remove candidate:</span> ${escapeHtml(candidate.quality)} (score ${candidate.score})</p>
        <p class="muted">${escapeHtml(confidenceFor(group, group.keep, candidate, group.keyTypes))}. ${escapeHtml(compareReason(group.keep, candidate))}</p>
        ${filesForVersion(candidate).map((file) => `<div class="file"><code>REMOVE CANDIDATE: ${escapeHtml(file)}</code></div>`).join("")}
      `).join("")}
    </section>
  `).join("")}
</main>
</body>
</html>
`;

  const paths = {
    json: `${base}.json`,
    csv: `${base}.csv`,
    markdown: `${base}.md`,
    html: `${base}.html`,
    latestJson: `${latestBase}.json`,
    latestCsv: `${latestBase}.csv`,
    latestMarkdown: `${latestBase}.md`,
    latestHtml: `${latestBase}.html`,
  };

  fs.writeFileSync(paths.json, JSON.stringify(json, null, 2), "utf8");
  fs.writeFileSync(paths.csv, csv, "utf8");
  fs.writeFileSync(paths.markdown, mdLines.join("\n"), "utf8");
  fs.writeFileSync(paths.html, html, "utf8");
  fs.copyFileSync(paths.json, paths.latestJson);
  fs.copyFileSync(paths.csv, paths.latestCsv);
  fs.copyFileSync(paths.markdown, paths.latestMarkdown);
  fs.copyFileSync(paths.html, paths.latestHtml);
  return { paths, summary: json.summary };
}

function escapeMarkdown(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const generatedAt = new Date().toISOString();
  const token = await resolvePlexToken(options);
  const sections = await listMovieSections(token, options);
  if (sections.length === 0) {
    throw new Error(options.library ? `No Plex movie library matched "${options.library}".` : "No Plex movie libraries were found.");
  }

  const moviesNested = [];
  for (const section of sections) {
    moviesNested.push(await listMoviesInSection(section, token, options));
  }
  const movies = moviesNested.flat();
  const decisions = loadDecisions(options.decisionsPath);
  const duplicateGroups = buildDuplicateGroups(movies);
  const { groups, ignoredCandidatesSkipped } = applyIgnoredDecisions(duplicateGroups, decisions);
  const report = writeReports({ generatedAt, options, sections, movies, groups, ignoredCandidatesSkipped });

  console.log(`Plex duplicate movie scan complete.`);
  console.log(`Movie libraries scanned: ${report.summary.movieLibrariesScanned}`);
  console.log(`Movies scanned: ${report.summary.moviesScanned}`);
  console.log(`Duplicate groups found: ${report.summary.duplicateGroups}`);
  console.log(`Remove candidates listed: ${report.summary.removeCandidates}`);
  console.log(`Ignored candidates skipped: ${report.summary.ignoredCandidatesSkipped}`);
  console.log(`Markdown: ${report.paths.markdown}`);
  console.log(`HTML: ${report.paths.html}`);
  console.log(`CSV: ${report.paths.csv}`);
  console.log(`JSON: ${report.paths.json}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
