import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync, existsSync, symlinkSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";

const standalone = mkdtempSync(join(tmpdir(), "jieli-standalone-"));
after(() => rmSync(standalone, { recursive: true, force: true }));
const entry = join(standalone, "jieli-sync.mjs");
copyFileSync(new URL("../dist/jieli-sync.mjs", import.meta.url), entry);

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "jieli-history-test-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

function jsonl(path, rows) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  return path;
}

function codex(home, id, text = "hello", extra = {}) {
  return jsonl(join(home, ".codex", "sessions", `rollout-${id}.jsonl`), [
    { type: "session_meta", timestamp: "2026-10-01T12:00:00Z", payload: { id, cwd: join(home, "project"), ...extra } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } },
  ]);
}

async function receiver(t, respond = () => null) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const request = { path: req.url, body, key: req.headers.authorization };
    requests.push(request);
    const custom = await respond(request);
    res.writeHead(custom?.status || 200, { "content-type": "application/json" });
    res.end(JSON.stringify(custom?.body || (req.url === "/plugin/attachments"
      ? { url: `${url}/attachments/image.png` } : { success: true })));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((done) => { server.closeAllConnections(); server.close(done); }));
  return { url, requests };
}

async function run(home, url, args = [], env = {}, onChild = () => {}, executable = entry) {
  const child = spawn(process.execPath, [executable, ...args], {
    cwd: home,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: home,
      JIELI_BASE_URL: url,
      JIELI_API_KEY: "test-key",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  onChild(child);
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((done) => child.on("close", done));
  return { code, stdout, stderr };
}

test("default CLI uploads both agents with plugin normalization and skips unchanged history on rerun", async (t) => {
  const home = fixture(t);
  const server = await receiver(t);
  codex(home, "codex-one", "JIELI_API_KEY=sk-sensitive-history-key");
  jsonl(join(home, ".claude", "projects", "project", "claude-one.jsonl"), [
    { type: "user", sessionId: "claude-one", cwd: join(home, "project"), uuid: "u1", message: { role: "user", content: "hello Claude" } },
    { type: "ai-title", aiTitle: "Historical Claude title" },
  ]);
  let result = await run(home, server.url);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(server.requests.length, 2);
  assert.deepEqual(new Set(server.requests.map((r) => r.body.provider)), new Set(["codex", "claude_code"]));
  const codexThread = server.requests.find((r) => r.body.provider === "codex").body.thread;
  assert.equal(codexThread.id, "T-codex-one");
  assert.doesNotMatch(JSON.stringify(codexThread), /sk-sensitive-history-key/);
  assert.match(JSON.stringify(codexThread.messages), /REDACTED/);
  assert.equal(codexThread.summaryStats, undefined);
  assert.equal(server.requests.find((r) => r.body.provider === "claude_code").body.thread.title, "Historical Claude title");
  result = await run(home, server.url);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /0 uploaded, 2 skipped, 0 failed/);
  assert.equal(server.requests.length, 2);
});

test("configuration uses settings without a terminal, allows environment overrides, and fails on missing credentials", async (t) => {
  const home = fixture(t);
  const first = await receiver(t);
  const second = await receiver(t);
  codex(home, "configured");
  const settings = join(home, ".config", "jieli", "settings.json");
  mkdirSync(dirname(settings), { recursive: true });
  writeFileSync(settings, JSON.stringify({ api_key: "settings-key", base_url: first.url }));
  let result = await run(home, "", [], { JIELI_API_KEY: "" });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(first.requests[0].key, "Bearer settings-key");
  result = await run(home, second.url, [], { JIELI_API_KEY: "env-key" });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(second.requests[0].key, "Bearer env-key");
  rmSync(settings);
  result = await run(home, first.url, [], { JIELI_API_KEY: "" });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /JIELI_API_KEY.*settings.json/);
  assert.equal(first.requests.length, 1);
  result = await run(home, "file:///tmp/wrong");
  assert.equal(result.code, 1);
  assert.match(result.stderr, /http/);
});

test("attachment failures do not upload partial threads and retries are isolated by credential", async (t) => {
  const home = fixture(t);
  let fail = true;
  const server = await receiver(t, (request) => request.path === "/plugin/attachments" && fail ? { status: 500 } : null);
  jsonl(join(home, ".codex", "sessions", "rollout-images.jsonl"), [
    { type: "session_meta", payload: { id: "images", cwd: home } },
    { type: "response_item", payload: { type: "message", role: "user", content: [
      { type: "input_text", text: "inspect this" },
      { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" },
    ] } },
  ]);
  let result = await run(home, server.url);
  assert.equal(result.code, 1, result.stdout);
  assert.equal(server.requests.filter((r) => r.path === "/plugin/threads/upload").length, 0);
  fail = false;
  result = await run(home, server.url);
  assert.equal(result.code, 0, result.stderr);
  const uploads = server.requests.filter((r) => r.path === "/plugin/threads/upload");
  assert.equal(uploads.length, 1);
  assert.match(JSON.stringify(uploads[0].body.thread.messages), /attachments\/image.png/);
  result = await run(home, server.url, [], { JIELI_API_KEY: "another-account" });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(server.requests.filter((r) => r.path === "/plugin/attachments").length, 3);
  assert.equal(server.requests.at(-1).key, "Bearer another-account");
});

test("failed sessions remain retryable while successful sessions and changed source are handled separately", async (t) => {
  const home = fixture(t);
  let fail = true;
  const server = await receiver(t, (r) => r.body.thread?.id === "T-a" && fail ? { status: 500 } : null);
  codex(home, "a");
  codex(home, "b");
  let result = await run(home, server.url);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /1 uploaded, 0 skipped, 1 failed/);
  fail = false;
  result = await run(home, server.url);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /1 uploaded, 1 skipped, 0 failed/);
  codex(home, "b", "new message");
  result = await run(home, server.url);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /1 uploaded, 1 skipped, 0 failed/);
  assert.equal(server.requests.at(-1).body.thread.messages[0].content, "new message");
  result = await run(home, server.url, ["--force"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /2 uploaded, 0 skipped, 0 failed/);
});

test("Codex history imports only the unique current leaf and preserves archived sessions", async (t) => {
  const home = fixture(t);
  const server = await receiver(t);
  const parent = codex(home, "stable", "retained prefix");
  const boundary = readFileSync(parent).length;
  writeFileSync(parent, JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: "reverted tail" } }) + "\n", { flag: "a" });
  const leaf = jsonl(join(dirname(parent), "rollout-stable_segment-1.jsonl"), [
    { type: "session_meta", payload: { id: "stable", cwd: home,
      history_base: { thread_id: "stable", end_byte_offset: boundary, end_ordinal_exclusive: 2 } } },
    { type: "response_item", payload: { type: "message", role: "user", content: "current tail" } },
  ]);
  const archived = codex(home, "archived");
  const archiveDir = join(home, ".codex", "archived_sessions");
  mkdirSync(archiveDir);
  renameSync(archived, join(archiveDir, "rollout-archived.jsonl"));
  let result = await run(home, server.url);
  assert.equal(result.code, 0, result.stderr);
  const thread = server.requests.find((r) => r.body.thread?.id === "T-stable").body.thread;
  assert.deepEqual(thread.messages.map((m) => m.content), ["retained prefix", "current tail"]);
  assert.equal(server.requests.filter((r) => r.body.thread?.id === "T-stable").length, 1);
  assert.deepEqual(server.requests.find((r) => r.path === "/plugin/threads/archive").body,
    { provider: "codex", provider_thread_id: "T-archived", archived: true });
  result = await run(home, server.url);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /0 uploaded, 2 skipped, 0 failed/);
  // An explicit file still needs to locate its byte-bounded parent history.
  result = await run(home, server.url, ["--agent", "codex", "--file", leaf, "--force"]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(server.requests.at(-1).body.thread.messages.map((m) => m.content), ["retained prefix", "current tail"]);
});

test("ambiguous history cannot overwrite a thread unless the user selects a file", async (t) => {
  const home = fixture(t);
  const server = await receiver(t);
  const selected = codex(home, "duplicate", "chosen version");
  writeFileSync(join(dirname(selected), "rollout-other.jsonl"), readFileSync(selected));
  let result = await run(home, server.url);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /ambiguous/);
  assert.equal(server.requests.length, 0);
  result = await run(home, server.url, ["--agent", "codex", "--file", selected]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(server.requests.length, 1);
});

test("CLI rejects malformed input and wrong options without broadening upload scope", async (t) => {
  const home = fixture(t);
  const server = await receiver(t);
  const broken = codex(home, "broken");
  writeFileSync(broken, '{"type":', { flag: "a" });
  for (const args of [[], ["--agent", "wrong"], ["--file", broken], ["--agent", "codex", "--file", join(home, "missing")], ["--unknown"]]) {
    const result = await run(home, server.url, args);
    assert.notEqual(result.code, 0);
  }
  assert.equal(server.requests.length, 0);
  const result = await run(home, server.url, [], { CODEX_HOME: join(home, "missing-home") });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /CODEX_HOME/);
  const ordinaryFile = join(home, "not-a-directory");
  writeFileSync(ordinaryFile, "data");
  for (const variable of ["CODEX_HOME", "CLAUDE_CONFIG_DIR"]) {
    const invalidHome = await run(home, server.url, [], { [variable]: ordinaryFile });
    assert.equal(invalidHome.code, 1);
    assert.match(invalidHome.stderr, /directory/);
  }
  codex(home, "broken", "now valid");
  for (const args of [["--agent", ""], ["--agent", "codex", "--file", ""]]) {
    const result = await run(home, server.url, args);
    assert.equal(result.code, 1);
  }
  assert.equal(server.requests.length, 0);
});

test("agent selection excludes subagent histories and empty sessions, including symlinked homes", async (t) => {
  const home = fixture(t);
  const server = await receiver(t);
  codex(home, "not-selected");
  const projects = join(home, "claude-config", "projects", "project");
  const row = { type: "user", sessionId: "main", cwd: home, uuid: "message-1", message: { role: "user", content: "main session" } };
  jsonl(join(projects, "main.jsonl"), [row]);
  jsonl(join(projects, "subagents", "agent-one.jsonl"), [{ ...row, sessionId: "child" }]);
  jsonl(join(projects, "agent-old.jsonl"), [{ ...row, sessionId: "old-child", isSidechain: true }]);
  jsonl(join(projects, "empty.jsonl"), [{ type: "progress", sessionId: "empty" }]);
  symlinkSync(join(home, "claude-config"), join(home, ".claude"), "dir");
  const result = await run(home, server.url, ["--agent", "claude-code"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0].body.thread.id, "T-main");
  assert.equal(existsSync(join(home, ".jieli", "claude_code-summary-stats.json")), false);
  assert.equal(existsSync(join(home, ".jieli", "claude-sessions.json")), false);
});

test("authentication and quota failures stop the batch and never expose the API key", async (t) => {
  for (const status of [401, 403, 409, 429]) {
    const home = fixture(t);
    const server = await receiver(t, () => ({ status, body: { message: "test-key" } }));
    codex(home, "a");
    codex(home, "b");
    const result = await run(home, server.url);
    assert.equal(result.code, 1);
    assert.equal(server.requests.length, 1);
    assert.doesNotMatch(result.stderr, /test-key/);
    assert.match(result.stderr, /rerun|Retry|retry/i);
  }
});

test("concurrent history sync is excluded and interruption releases the lock for rerun", async (t) => {
  const home = fixture(t);
  let entered;
  const started = new Promise((done) => { entered = done; });
  const server = await receiver(t, async () => {
    entered();
    await new Promise((done) => setTimeout(done, 250));
  });
  codex(home, "locked");
  let child;
  const first = run(home, server.url, [], {}, (process) => { child = process; });
  await started;
  const concurrent = await run(home, server.url);
  assert.equal(concurrent.code, 1);
  assert.match(concurrent.stderr, /Another history sync/);
  child.kill("SIGTERM");
  await first;
  const result = await run(home, server.url);
  assert.equal(result.code, 0, result.stderr);
});

test("a transcript changed while uploading an image cannot replace the remote thread", async (t) => {
  const home = fixture(t);
  const path = jsonl(join(home, ".codex", "sessions", "rollout-changing.jsonl"), [
    { type: "session_meta", payload: { id: "changing", cwd: home } },
    { type: "response_item", payload: { type: "message", role: "user", content: [
      { type: "input_text", text: "inspect changing image" },
      { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" },
    ] } },
  ]);
  const server = await receiver(t, (request) => {
    if (request.path === "/plugin/attachments") writeFileSync(path, "\n", { flag: "a" });
  });
  const result = await run(home, server.url);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /changed during sync/);
  assert.equal(server.requests.filter((r) => r.path === "/plugin/threads/upload").length, 0);
});

test("custom agent homes override defaults and destination URL isolates completed uploads", async (t) => {
  const home = fixture(t);
  const first = await receiver(t), second = await receiver(t);
  codex(home, "custom-codex");
  const customCodex = join(home, "custom-codex-home");
  renameSync(join(home, ".codex"), customCodex);
  codex(home, "default-decoy");
  const customClaude = join(home, "custom-claude-home");
  jsonl(join(customClaude, "projects", "project", "session.jsonl"), [
    { type: "user", sessionId: "custom-claude", cwd: home, message: { role: "user", content: "custom home" } },
  ]);
  const env = { CODEX_HOME: customCodex, CLAUDE_CONFIG_DIR: customClaude };
  for (const server of [first, second]) {
    const result = await run(home, server.url, [], env);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(new Set(server.requests.map((r) => r.body.thread.id)), new Set(["T-custom-codex", "T-custom-claude"]));
    assert.ok(server.requests.every((r) => r.key === "Bearer test-key"));
  }
});

test("macOS Desktop discovery deduplicates an aliased CLI root", { skip: process.platform !== "darwin" }, async (t) => {
  const home = fixture(t);
  const server = await receiver(t);
  codex(home, "shared-root");
  const desktop = join(home, "Library", "Application Support", "Codex");
  mkdirSync(dirname(desktop), { recursive: true });
  symlinkSync(join(home, ".codex"), desktop, "dir");
  const result = await run(home, server.url);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0].body.thread.id, "T-shared-root");
});

test("missing, ambiguous and invalid Codex history bases cannot upload partial snapshots", async (t) => {
  const home = fixture(t);
  const server = await receiver(t);
  const parent = codex(home, "stable", "prefix");
  const boundary = readFileSync(parent).length;
  const leaf = join(dirname(parent), "rollout-child.jsonl");
  const bases = [
    { thread_id: "missing", end_byte_offset: boundary, end_ordinal_exclusive: 2 },
    { thread_id: "stable", end_byte_offset: boundary + 1, end_ordinal_exclusive: 2 },
    { thread_id: "child", end_byte_offset: 0, end_ordinal_exclusive: 0 },
  ];
  for (const base of bases) {
    jsonl(leaf, [{ type: "session_meta", payload: { id: "stable", history_base: base } }]);
    const result = await run(home, server.url, ["--agent", "codex", "--file", leaf]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /history_base|byte boundary|cyclic/i);
  }
  writeFileSync(join(dirname(parent), "duplicate-stable.jsonl"), readFileSync(parent));
  jsonl(leaf, [{ type: "session_meta", payload: { id: "stable", history_base: { thread_id: "stable", end_byte_offset: boundary, end_ordinal_exclusive: 2 } } }]);
  const result = await run(home, server.url, ["--agent", "codex", "--file", leaf]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /found 2/);
  assert.equal(server.requests.length, 0);
});

test("truncated Codex descendants never promote an older parent into an uploadable leaf", async (t) => {
  for (const knownIdentity of [true, false]) {
    const home = fixture(t);
    const server = await receiver(t);
    const parent = codex(home, "stable", "old prefix");
    const leaf = join(dirname(parent), "rollout-stable_current.jsonl");
    const prefix = knownIdentity ? JSON.stringify({ type: "session_meta", payload: { id: "stable", history_base: {
      thread_id: "stable", end_byte_offset: readFileSync(parent).length, end_ordinal_exclusive: 2,
    } } }) + "\n" : "";
    writeFileSync(leaf, prefix + '{"type":');
    codex(home, "independent", "unrelated history");
    const result = await run(home, server.url);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /invalid JSONL/);
    const ids = server.requests.filter((r) => r.path === "/plugin/threads/upload").map((r) => r.body.thread.id);
    assert.deepEqual(ids, knownIdentity ? ["T-independent"] : []);
  }
});

test("missing local images warn without losing text and force can import a restored image", async (t) => {
  const home = fixture(t);
  const server = await receiver(t);
  const image = join(home, "pasted.png");
  jsonl(join(home, ".codex", "sessions", "rollout-local-image.jsonl"), [
    { type: "session_meta", payload: { id: "local-image", cwd: home } },
    { type: "event_msg", payload: { type: "user_message", message: "inspect local image", local_images: [image] } },
  ]);
  let result = await run(home, server.url);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /local image no longer exists/);
  assert.match(JSON.stringify(server.requests[0].body.thread.messages), /inspect local image/);
  writeFileSync(image, "image bytes");
  result = await run(home, server.url, ["--force"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(JSON.stringify(server.requests.at(-1).body.thread.messages), /attachments\/image.png/);
});

test("an archive failure remains retryable until the archived state succeeds", async (t) => {
  const home = fixture(t);
  let failArchive = true;
  const server = await receiver(t, (r) => r.path === "/plugin/threads/archive" && failArchive ? { status: 500 } : null);
  const original = codex(home, "archive-retry");
  const destination = join(home, ".codex", "archived_sessions", "rollout-archive-retry.jsonl");
  mkdirSync(dirname(destination)); renameSync(original, destination);
  let result = await run(home, server.url);
  assert.equal(result.code, 1);
  failArchive = false;
  result = await run(home, server.url);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(server.requests.filter((r) => r.path === "/plugin/threads/archive").length, 2);
  result = await run(home, server.url);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(server.requests.length, 4);
});

test("rebuilding after a plugin change updates the standalone behavior and invalidates old progress", async (t) => {
  const home = fixture(t), checkout = fixture(t);
  const server = await receiver(t);
  const repository = fileURLToPath(new URL("../", import.meta.url));
  for (const path of ["scripts", "plugins/codex/scripts", "plugins/claude-code/scripts"]) cpSync(join(repository, path), join(checkout, path), { recursive: true });
  symlinkSync(join(repository, "node_modules"), join(checkout, "node_modules"), "dir");
  const build = () => {
    const result = spawnSync(process.execPath, [join(checkout, "scripts", "build-history.mjs")], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  const executable = join(checkout, "dist", "jieli-sync.mjs");
  codex(home, "rebuild", "original title");
  build();
  let result = await run(home, server.url, [], {}, undefined, executable);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(server.requests[0].body.thread.title, "original title");
  const runtime = join(checkout, "plugins", "codex", "scripts", "jieli_node.mjs");
  writeFileSync(runtime, readFileSync(runtime, "utf8").replace("codexDesktopTitle(sessionId) || transcript.title", '"Changed plugin title" || transcript.title'));
  build();
  result = await run(home, server.url, [], {}, undefined, executable);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(server.requests.length, 2);
  assert.equal(server.requests[1].body.thread.title, "Changed plugin title");
});
