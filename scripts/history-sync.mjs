#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import * as codex from "../plugins/codex/scripts/jieli_node.mjs";
import * as claude from "../plugins/claude-code/scripts/jieli_node.mjs";

const runtimes = { codex, "claude-code": claude };
const hash = (value) => createHash("sha256").update(value).digest("hex");
// Re-upload completed history when the published file changes.
const buildId = hash(readFileSync(fileURLToPath(import.meta.url)));
let activeApiKey = "";
const safeText = (value) => codex.redactText(activeApiKey ? String(value).split(activeApiKey).join("[REDACTED]") : String(value));

async function configuration() {
  const settingsPath = join(homedir(), ".config", "jieli", "settings.json");
  const text = (value) => typeof value === "string" ? value.trim() : "";
  let settings = {};
  if ((!text(process.env.JIELI_API_KEY) || !text(process.env.JIELI_BASE_URL)) && existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, "utf8").replace(/^\uFEFF/, "")); }
    catch { throw new Error(`Cannot read valid JSON from ${settingsPath}`); }
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error(`Invalid settings object: ${settingsPath}`);
  }
  let baseUrl = text(process.env.JIELI_BASE_URL) || text(settings.base_url) || text(settings.JIELI_BASE_URL);
  let apiKey = text(process.env.JIELI_API_KEY) || text(settings.api_key) || text(settings.JIELI_API_KEY);
  if (process.stdin.isTTY && (!baseUrl || !apiKey)) {
    let muted = false;
    const output = new Writable({ write(chunk, _encoding, done) {
      if (!muted) process.stdout.write(chunk);
      done();
    } });
    const rl = createInterface({ input: process.stdin, output, terminal: true });
    rl.on("SIGINT", () => rl.close());
    try {
      if (!baseUrl) baseUrl = (await rl.question("JIELI_BASE_URL [https://jieli.app]: ")).trim() || "https://jieli.app";
      if (!apiKey) {
        process.stdout.write("JIELI_API_KEY (input hidden): ");
        muted = true;
        apiKey = (await rl.question("")).trim();
        muted = false;
        process.stdout.write("\n");
      }
    } finally { rl.close(); }
  }
  if (!apiKey) throw new Error("Set JIELI_API_KEY or api_key in ~/.config/jieli/settings.json, or run in a terminal to enter it.");
  activeApiKey = apiKey;
  const url = new URL(baseUrl || "https://jieli.app");
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("JIELI_BASE_URL must be an http(s) URL without credentials, query or fragment");
  }
  return { baseUrl: url.href.replace(/\/+$/, ""), apiKey };
}

function transcript(path, agent, archived) {
  const bytes = readFileSync(path);
  const decoded = agent === "codex" ? codex.decodeTranscriptBytes(path, bytes) : bytes;
  let meta, hasRows = false, sidechain = false;
  const invalidRecord = (message) => Object.assign(new Error(message), {
    sessionId: agent === "codex" ? meta?.id : meta?.sessionId || meta?.session_id,
  });
  for (const [index, line] of decoded.toString("utf8").split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { throw invalidRecord(`invalid JSONL at line ${index + 1}`); }
    if (!row || typeof row !== "object" || Array.isArray(row)) throw invalidRecord(`invalid JSONL object at line ${index + 1}`);
    hasRows = true;
    if (agent === "codex") {
      if (!meta && row.type === "session_meta") meta = row.payload;
    } else {
      if (!meta && (row.sessionId || row.session_id)) meta = row;
      if (row.isSidechain) sidechain = true;
    }
  }
  if (!hasRows || sidechain) return null;
  const id = agent === "codex" ? meta?.id : meta?.sessionId || meta?.session_id;
  if (typeof id !== "string" || !id.trim()) throw new Error("missing session id");
  return { path, agent, archived, id, digest: hash(bytes), base: meta?.history_base, cwd: meta?.cwd || "" };
}

function codexRoot(path) {
  let root = dirname(path);
  while (!["sessions", "archived_sessions"].includes(basename(root)) && dirname(root) !== root) root = dirname(root);
  return root;
}

function discover(opts) {
  const found = [], errors = [], seen = new Set(), directories = new Set(), codexPaths = new Map();
  const blockedSessions = new Set(), blockedAgents = new Set();
  function add(path, agent, archived) {
    try {
      path = realpathSync(path);
      if (seen.has(path)) return;
      seen.add(path);
      const item = transcript(path, agent, archived);
      if (item) found.push(item);
      if (agent === "codex") codexPaths.set(path, item);
    } catch (error) {
      if (typeof error.sessionId === "string" && error.sessionId.trim()) {
        blockedSessions.add(`${agent}:${error.sessionId}`);
        errors.push(`${path}: ${error.message}; this session will not be uploaded`);
      } else {
        blockedAgents.add(agent);
        errors.push(`${path}: ${error.message}; session identity unknown, stopping ${agent} discovery`);
      }
    }
  }
  function walk(root, agent, archived = false, indexOnly = false) {
    if (!existsSync(root)) return;
    root = realpathSync(root);
    if (directories.has(root)) return;
    directories.add(root);
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (entry.isDirectory() && entry.name !== "subagents") walk(path, agent, archived, indexOnly);
      else if (entry.isFile() && (agent === "codex" ? codex.isCodexRolloutPath(entry.name) : entry.name.endsWith(".jsonl"))) {
        if (indexOnly) { if (!codexPaths.has(path)) codexPaths.set(path, null); }
        else add(path, agent, archived);
      }
    }
  }
  if (opts.file) {
    add(resolve(opts.file), opts.agent, resolve(opts.file).split(/[\\/]/).includes("archived_sessions"));
    if (opts.agent === "codex" && found[0]?.base) {
      const root = codexRoot(found[0].path);
      if (dirname(root) === root) throw new Error("Codex history_base must be inside sessions or archived_sessions");
      walk(root, "codex", found[0].archived, true);
    }
  } else {
    for (const [agent, variable] of [["codex", "CODEX_HOME"], ["claude-code", "CLAUDE_CONFIG_DIR"]]) {
      if ((!opts.agent || opts.agent === agent) && process.env[variable]) {
        if (!existsSync(process.env[variable])) throw new Error(`${variable} does not exist`);
        if (!statSync(process.env[variable]).isDirectory()) throw new Error(`${variable} must point to a directory`);
      }
    }
    if (!opts.agent || opts.agent === "codex") {
      const roots = process.env.CODEX_HOME ? [resolve(process.env.CODEX_HOME)] : [join(homedir(), ".codex")];
      if (!process.env.CODEX_HOME && process.platform === "darwin") roots.push(join(homedir(), "Library", "Application Support", "Codex"));
      for (const root of roots) {
        walk(join(root, "sessions"), "codex");
        walk(join(root, "archived_sessions"), "codex", true);
      }
    }
    if (!opts.agent || opts.agent === "claude-code") walk(join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects"), "claude-code");
  }
  // Index physical suffixes once, rather than rescanning every file for each base.
  const bases = new Map();
  for (const path of codexPaths.keys()) {
    const name = basename(path).replace(/\.zst$/, ""), root = codexRoot(path);
    for (const match of name.matchAll(/[-_]/g)) {
      const key = `${root}\0${name.slice(match.index + 1, -6)}`;
      if (!bases.has(key)) bases.set(key, []);
      bases.get(key).push(path);
    }
  }
  const referenced = new Set();
  function sources(item, visiting = new Set()) {
    if (visiting.has(item.path)) throw new Error("cyclic Codex history_base");
    if (item.sources) return item.sources;
    visiting.add(item.path);
    let parents = [];
    if (item.agent === "codex" && item.base) {
      const matches = bases.get(`${codexRoot(item.path)}\0${item.base.thread_id}`) || [];
      if (matches.length !== 1) throw new Error(`expected one history_base ${item.base.thread_id}, found ${matches.length}`);
      const path = matches[0];
      let parent = codexPaths.get(path);
      if (!parent) { parent = transcript(path, "codex", item.archived); codexPaths.set(path, parent); }
      if (!parent) throw new Error(`empty history_base: ${path}`);
      if (parent.id === item.id) referenced.add(path);
      parents = sources(parent, visiting);
    }
    visiting.delete(item.path);
    item.sources = [...parents, { path: item.path, digest: item.digest }];
    return item.sources;
  }
  const groups = new Map();
  for (const item of found) {
    const key = `${item.agent}:${item.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const sessions = [];
  for (const [key, items] of groups) {
    if (blockedAgents.has(items[0].agent) || blockedSessions.has(key)) continue;
    try {
      for (const item of items) sources(item);
      const leaves = items.filter((item) => !referenced.has(item.path));
      if (leaves.length !== 1) throw new Error(`ambiguous transcripts; select one with --agent and --file: ${items.map((i) => i.path).join(", ")}`);
      sessions.push(leaves[0]);
    } catch (error) { errors.push(`${key}: ${error.message}`); }
  }
  return { sessions, errors };
}

async function main() {
  if (Number(process.versions.node.split(".")[0]) < 20) throw new Error("Node.js 20 or newer is required");
  const { values: opts } = parseArgs({ options: {
    help: { type: "boolean", short: "h" },
    agent: { type: "string" }, file: { type: "string" }, force: { type: "boolean" },
  } });
  if (opts.help) {
    console.log("Usage: node jieli-sync.mjs [--agent codex|claude-code] [--file PATH] [--force]\nUploads local history using JIELI_API_KEY and JIELI_BASE_URL (default https://jieli.app).\n--file requires --agent. --force re-uploads previously completed history.");
    return 0;
  }
  if (opts.agent !== undefined && !Object.hasOwn(runtimes, opts.agent)) throw new Error("--agent must be codex or claude-code");
  if (opts.file !== undefined && !opts.file.trim()) throw new Error("--file must not be empty");
  if (opts.file && !opts.agent) throw new Error("--file requires --agent");
  const { baseUrl, apiKey } = await configuration();
  const { sessions, errors } = discover(opts);
  console.log(`Destination: ${baseUrl}\nFound ${sessions.length} sessions.`);
  for (const error of errors) console.error(safeText(error));
  let uploaded = 0, skipped = 0, failed = errors.length;
  const attachments = new Map();
  const stateDir = join(homedir(), ".jieli", "history-sync", hash(`${baseUrl}\0${apiKey}`));
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const lock = join(stateDir, "lock");
  try { mkdirSync(lock); } catch (error) {
    if (error.code !== "EEXIST") throw error;
    throw new Error(`Another history sync is running. If it was interrupted, remove ${lock} after checking it has stopped.`);
  }
  const interrupted = () => { rmSync(lock, { recursive: true }); process.exit(130); };
  const terminated = () => { rmSync(lock, { recursive: true }); process.exit(143); };
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", terminated);
  try {
    for (const session of sessions) {
      const label = `${session.agent}:${session.id}`;
      const stateFile = join(stateDir, `${hash(label)}.json`);
      const fingerprint = hash(`${buildId}\0${session.sources.map((s) => s.digest).join(":")}\0${session.archived}`);
      try {
        if (!opts.force && existsSync(stateFile) && JSON.parse(readFileSync(stateFile, "utf8")).fingerprint === fingerprint) {
          skipped++;
          console.log(`SKIP ${label} (unchanged)`);
          continue;
        }
        const runtime = runtimes[session.agent];
        const attachmentErrors = [];
        const uploadImage = async (bytes, mediaType, upload) => {
          const key = `${mediaType}:${hash(bytes)}`;
          try {
            if (!attachments.has(key)) attachments.set(key, await upload());
            return attachments.get(key);
          } catch (error) { attachmentErrors.push(error); return null; }
        };
        const imageUploader = async (path) => {
          let bytes;
          try { bytes = readFileSync(path); } catch (error) {
            if (error.code === "ENOENT") console.error(safeText(`WARN ${label}: local image no longer exists: ${path}`));
            else attachmentErrors.push(error);
            return null;
          }
          return uploadImage(bytes, extname(path).toLowerCase(), () => runtime.uploadAttachment(path, baseUrl, apiKey));
        };
        const dataUploader = (bytes, mediaType) => uploadImage(bytes, mediaType, () => runtime.uploadAttachmentData(bytes, mediaType, baseUrl, apiKey));
        const hook = { transcript_path: session.path, session_id: session.id, cwd: session.cwd, trigger: "history" };
        const payload = session.agent === "codex"
          ? await runtime.buildPayloadFromHook(hook, baseUrl, imageUploader, dataUploader, { includeSummaryStats: false })
          : await runtime.buildPayloadFromHook(hook, baseUrl, imageUploader, { includeSummaryStats: false });
        if (attachmentErrors.length) throw attachmentErrors[0];
        if (!payload.thread.messages.length) { skipped++; console.log(`SKIP ${label} (empty)`); continue; }
        if (session.sources.some((source) => hash(readFileSync(source.path)) !== source.digest)) throw new Error("transcript changed during sync; stop the agent and rerun");
        await runtime.uploadPayload(payload, baseUrl, apiKey);
        if (session.agent === "codex" && session.archived) await codex.archiveThread(payload.thread.id, true, baseUrl, apiKey);
        const temp = `${stateFile}.tmp`;
        writeFileSync(temp, JSON.stringify({ fingerprint }) + "\n", { mode: 0o600 });
        renameSync(temp, stateFile);
        uploaded++;
        console.log(`OK ${label} (${payload.thread.messages.length} messages)`);
      } catch (error) {
        failed++;
        console.error(safeText(`FAIL ${label}: ${error.message}`));
        const status = /HTTP (401|403|409|429)\b/.exec(error.message)?.[1];
        if (status) {
          console.error(status === "429" ? "Rate limited: wait at least a minute, then rerun to resume."
            : status === "409" ? "Check the instance's message quota, then rerun to resume."
              : "Check the API key and instance URL, then rerun to resume.");
          break;
        }
      }
    }
  } finally {
    process.removeListener("SIGINT", interrupted);
    process.removeListener("SIGTERM", terminated);
    rmSync(lock, { recursive: true });
  }
  console.log(`${uploaded} uploaded, ${skipped} skipped, ${failed} failed.`);
  return failed ? 1 : 0;
}

try { process.exitCode = await main(); }
catch (error) { console.error(safeText(`History sync failed: ${error.message}`)); process.exitCode = 1; }
