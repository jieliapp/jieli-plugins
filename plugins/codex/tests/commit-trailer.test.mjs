import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as codex from "../scripts/jieli_node.mjs";
import * as claude from "../../claude-code/scripts/jieli_node.mjs";
import { withEnv } from "../../test_helpers/runtime.mjs";

for (const [provider, runtime] of [["codex", codex], ["claude", claude]]) {
  test(`${provider}: hook trailers cover every literal cross-repo batch commit`, async (t) => {
    const temp = mkdtempSync(join(tmpdir(), "jieli-trailers-"));
    t.after(() => rmSync(temp, { recursive: true, force: true }));
    const git = (...args) => {
      const r = spawnSync("git", args, { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim();
    };
    const repos = [join(temp, "repo 一"), join(temp, "repo two")];
    for (const repo of repos) {
      git("init", "-b", "main", repo);
      git("-C", repo, "config", "user.name", "Test");
      git("-C", repo, "config", "user.email", "test@example.test");
      git("-C", repo, "remote", "add", "origin", `git@github.com:acme/${repo === repos[0] ? "one" : "two"}.git`);
      writeFileSync(join(repo, "file.txt"), "change\n");
      git("-C", repo, "add", "file.txt");
    }
    const subject = "feat: literal ; | $(keep) -- 🐈";
    const command = `set -e\ng'i't -C '${repos[0]}' -c core.quotePath=false co'mm'it -m '${subject}' -- file.txt # keep comment\ngit -C '${repos[0]}' commit --allow-empty -m second; git -C '${repos[1]}' commit -m third\nfor repo in '${repos[0]}' '${repos[1]}'; do git -C "$repo" log -1 --format='%h %s'; git -C "$repo" status --short; done`;
    mkdirSync(join(temp, ".jieli"));
    writeFileSync(join(temp, ".jieli", provider === "codex" ? "codex-sessions.json" : "claude-sessions.json"), JSON.stringify({ batch: { provider_thread_id: "T-batch", base_url: "https://jieli.example.test" } }));
    await withEnv({ HOME: temp }, async () => {
      const rewrite = (command) => runtime.buildHookResponse({ session_id: "batch", tool_name: "Bash", tool_input: { command } });
      const rewritten = rewrite(command).hookSpecificOutput?.updatedInput.command;
      assert.ok(rewritten, "all explicit commits receive a trailer");
      assert.deepEqual(rewrite(rewritten), {}, "repeated hooks do not duplicate trailers");
      const r = spawnSync("sh", ["-c", rewritten], { encoding: "utf8", cwd: temp });
      assert.equal(r.status, 0, r.stderr);
      for (const [repo, ref] of [[repos[0], "HEAD^"], [repos[0], "HEAD"], [repos[1], "HEAD"]]) {
        assert.equal(git("-C", repo, "show", "-s", "--format=%(trailers:key=Jieli-Thread,valueonly)", ref), "https://jieli.example.test/threads/T-batch");
      }
      assert.equal(git("-C", repos[0], "show", "-s", "--format=%s", "HEAD^"), subject);
      assert.ok(rewritten.includes("# keep comment\n"));
      const transcript = join(temp, "session.jsonl");
      const entries = provider === "codex" ? [
        { type: "session_meta", payload: { id: "batch", cwd: repos[0] } },
        { type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "call", arguments: JSON.stringify({ cmd: rewritten, workdir: temp }) } },
        { type: "response_item", payload: { type: "function_call_output", call_id: "call", output: `Process exited with code 0\nOutput:\n${r.stdout}` } },
      ] : [
        { type: "assistant", uuid: "call", sessionId: "batch", cwd: temp, message: { role: "assistant", content: [{ type: "tool_use", id: "call", name: "Bash", input: { command: rewritten } }] } },
        { type: "user", uuid: "result", sessionId: "batch", cwd: temp, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call", content: r.stdout }] } },
      ];
      writeFileSync(transcript, entries.map(JSON.stringify).join("\n"));
      const payload = await runtime.buildPayloadFromHook({ transcript_path: transcript, session_id: "batch", cwd: repos[0] }, "https://jieli.example.test", null,
        ...(provider === "codex" ? [null, { includeSummaryStats: false }] : [{ includeSummaryStats: false }]));
      assert.deepEqual(payload.commits.map(c => c.commit_sha), [git("-C", repos[0], "rev-parse", "HEAD^"), git("-C", repos[0], "rev-parse", "HEAD"), git("-C", repos[1], "rev-parse", "HEAD")]);
    });
  });

  test(`${provider}: trailer edits preserve heredocs, redirects and existing trailer options`, async (t) => {
    const temp = mkdtempSync(join(tmpdir(), "jieli-trailer-source-"));
    t.after(() => rmSync(temp, { recursive: true, force: true }));
    const git = (...args) => {
      const r = spawnSync("git", args, { cwd: temp, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim();
    };
    git("init", "-b", "main");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.test");
    const body = "feat: heredoc stays intact\n\ngit commit -m 'this is data'\n; | $(touch must-not-exist)\n";
    const command = `cat > message.txt <<'EOF'\n${body}EOF\ngit commit --allow-empty -F message.txt > 'commit output.txt' 2>&1 # keep redirect\ngit commit --allow-empty -m -- --trailer='jieli-thread: previous'; git commit --allow-empty --trailer 'Reviewed-by: Peer' -m --\ngit commit --allow-empty -m subject -m 'Jieli-Thread: message-option'\ngit commit --allow-empty --message='subject\n\nJieli-Thread: attached-message'`;
    const baseURL = 'https://jieli.example.test/$(touch forbidden)`touch forbidden2`"quoted';
    mkdirSync(join(temp, ".jieli"));
    writeFileSync(join(temp, ".jieli", provider === "codex" ? "codex-sessions.json" : "claude-sessions.json"), JSON.stringify({ source: { provider_thread_id: "T-source", base_url: baseURL } }));
    await withEnv({ HOME: temp }, async () => {
      const hook = command => runtime.buildHookResponse({ session_id: "source", tool_name: "Bash", tool_input: { command } });
      const rewritten = hook(command).hookSpecificOutput?.updatedInput.command;
      assert.ok(rewritten);
      assert.deepEqual(hook(rewritten), {});
      const r = spawnSync("sh", ["-c", rewritten], { cwd: temp, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(readFileSync(join(temp, "message.txt"), "utf8"), body, "heredoc code-like text remains literal data");
      assert.match(readFileSync(join(temp, "commit output.txt"), "utf8"), /heredoc stays intact/);
      assert.ok(rewritten.includes("# keep redirect\n"));
      assert.equal(git("show", "-s", "--format=%(trailers:key=Jieli-Thread,valueonly)", "HEAD~4"), `${baseURL}/threads/T-source`);
      assert.equal(git("show", "-s", "--format=%(trailers:key=Jieli-Thread,valueonly)", "HEAD~3"), "previous");
      assert.equal(git("show", "-s", "--format=%(trailers:key=Jieli-Thread,valueonly)", "HEAD~2"), `${baseURL}/threads/T-source`);
      assert.equal(git("show", "-s", "--format=%(trailers:key=Reviewed-by,valueonly)", "HEAD~2"), "Peer");
      assert.equal(git("show", "-s", "--format=%s", "HEAD~2"), "--", "message values are not mistaken for pathspec separators");
      assert.equal(git("show", "-s", "--format=%(trailers:key=Jieli-Thread,valueonly)", "HEAD~1"), "message-option");
      assert.equal(git("show", "-s", "--format=%(trailers:key=Jieli-Thread,valueonly)", "HEAD"), "attached-message");
      for (const path of ["must-not-exist", "forbidden", "forbidden2"]) {
        assert.throws(() => readFileSync(join(temp, path)), { code: "ENOENT" });
      }
    });
  });

  test(`${provider}: unsupported executable structures are left untouched`, async (t) => {
    const temp = mkdtempSync(join(tmpdir(), "jieli-trailer-reject-"));
    t.after(() => rmSync(temp, { recursive: true, force: true }));
    mkdirSync(join(temp, ".jieli"));
    writeFileSync(join(temp, ".jieli", provider === "codex" ? "codex-sessions.json" : "claude-sessions.json"), JSON.stringify({ reject: { provider_thread_id: "T-reject", base_url: "https://jieli.example.test" } }));
    await withEnv({ HOME: temp }, async () => {
      for (const command of [
        'if true; then git commit -m hidden; fi',
        'later() { git commit -m hidden; }',
        'git commit -m hidden &',
        'git commit -m hidden | cat',
        'git status || git commit -m conditional',
        'git commit -m "$(touch forbidden)"',
        'git commit -m "unterminated',
        'git cherry-pick abcdef0',
      ]) {
        assert.deepEqual(runtime.buildHookResponse({ session_id: "reject", tool_name: "Bash", tool_input: { command } }), {}, command);
      }
    });
  });
}
