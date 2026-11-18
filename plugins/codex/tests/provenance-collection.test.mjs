import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  readFileSync,
  renameSync,
  mkdirSync,
  existsSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectGitEvidence } from "../../../scripts/git-provenance.mjs";
import { withEnv } from "../../test_helpers/runtime.mjs";

async function traceGit(f, run) {
  const realGit = spawnSync("which", ["git"], {
    encoding: "utf8",
  }).stdout.trim();
  const bin = join(f.temp, "bin"),
    log = join(f.temp, "git-calls.jsonl");
  mkdirSync(bin);
  writeFileSync(log, "");
  writeFileSync(
    join(bin, "git"),
    `#!${process.execPath}\nconst {appendFileSync}=require('node:fs');const {spawnSync}=require('node:child_process');const args=process.argv.slice(2);appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');const r=spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});process.exit(r.status??1);\n`,
    { mode: 0o700 },
  );
  await withEnv({ PATH: bin + ":" + process.env.PATH }, () =>
    run({
      calls: () =>
        readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map(JSON.parse),
      clear: () => writeFileSync(log, ""),
    }),
  );
}

function fixture(t) {
  const temp = mkdtempSync(join(tmpdir(), "jieli-collect-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const cwd = join(temp, "repo");
  const git = (...args) => {
    const result = spawnSync("git", args, {
      cwd: temp,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: "2026-11-10T00:00:00Z",
        GIT_COMMITTER_DATE: "2026-11-10T00:00:00Z",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trimEnd();
  };
  git("init", "-b", "main", cwd);
  git("-C", cwd, "config", "user.name", "Test");
  git("-C", cwd, "config", "user.email", "test@example.test");
  git("-C", cwd, "remote", "add", "origin", "git@github.com:acme/project.git");
  const commit = (name) => {
    writeFileSync(join(cwd, "file.txt"), name + "\n");
    git("-C", cwd, "add", ".");
    const output = git("-C", cwd, "commit", "-m", name);
    return { output, sha: git("-C", cwd, "rev-parse", "HEAD") };
  };
  return {
    temp,
    cwd,
    git,
    commit,
    collect: (messages) =>
      collectGitEvidence({
        provider: "codex",
        sessionId: "test",
        cwd: temp,
        messages,
        cacheDir: join(temp, "cache"),
      }),
  };
}
const user = (id) => ({
  role: "user",
  message_id: id,
  content: "Please change this",
});
const call = (id, cwd) => ({
  role: "assistant",
  message_id: id,
  content: [
    {
      type: "tool_use",
      id,
      name: "functions.exec_command",
      input: { cmd: `git -C "${cwd}" commit -m change`, workdir: cwd },
    },
  ],
});
const result = (id, output, exitCode = 0) => ({
  role: "tool",
  message_id: id + ":result",
  content: [
    {
      type: "tool_result",
      tool_use_id: id,
      run: { status: "completed", result: { output, exitCode } },
    },
  ],
});

test("set -e captures four worktree commits before a read-only loop", async (t) => {
  const f = fixture(t);
  const directories = [];
  for (let i = 0; i < 4; i++) {
    const repo = join(f.temp, `project-${i}`);
    const linked = join(f.temp, `linked-${i}`);
    f.git("init", "-b", "main", repo);
    f.git("-C", repo, "config", "user.name", "Test");
    f.git("-C", repo, "config", "user.email", "test@example.test");
    f.git("-C", repo, "remote", "add", "origin", `git@github.com:acme/project-${i}.git`);
    f.git("-C", repo, "commit", "--allow-empty", "-m", "base");
    f.git("-C", repo, "worktree", "add", "-b", "feature", linked);
    writeFileSync(join(linked, "file.txt"), `project ${i}\n`);
    f.git("-C", linked, "add", "file.txt");
    directories.push(linked);
  }
  const command = ["set -e", ...directories.map((dir, i) => `git -C "${dir}" commit -m "change ${i}"`),
    `for repo in ${directories.map(dir => `"${dir}"`).join(" ")}; do git -C "$repo" log -1 --format='%h %s'; git -C "$repo" status --short; done`].join("\n");
  const executed = spawnSync("/bin/sh", ["-c", command], {cwd: f.temp, encoding: "utf8"});
  assert.equal(executed.status, 0, executed.stderr);
  const candidate = call("batch", f.temp);
  candidate.content[0].input.cmd = command;
  const messages = [user("request"), candidate, result("batch", executed.stdout)];
  const shas = directories.map(dir => f.git("-C", dir, "rev-parse", "HEAD"));
  await traceGit(f, trace => {
    const captured = f.collect(messages);
    assert.deepEqual(captured.commits.map(c => c.commit_sha), shas);
    assert.deepEqual(captured.commits.map(c => c.git_remote_url), directories.map((_, i) => `git@github.com:acme/project-${i}.git`));
    assert.ok(captured.commits.every(c => c.commit_tool_use_id === "batch" && c.start_message_id === "request" && c.end_message_id === "batch:result"));
    trace.clear();
    assert.deepEqual(f.collect([...messages, user("later")]), captured);
    assert.equal(trace.calls().filter(args => args.includes("--verify") || args[0] === "patch-id").length, 0);
  });
});

test("structured edits retain their actual worktree and nested repository ownership", (t) => {
  const f = fixture(t);
  f.commit("base");
  const linked = join(f.temp, "linked");
  f.git("-C", f.cwd, "worktree", "add", "-b", "linked", linked);
  const nested = join(f.cwd, "plugins");
  f.git("init", nested);
  f.git("-C", nested, "remote", "add", "origin", "git@github.com:acme/plugins.git");
  const edit = (id, path) => ({
    role: "assistant", message_id: id,
    content: [{type: "tool_use", id, name: "functions.apply_patch", input: {patch_text: `*** Begin Patch\n*** Update File: ${path}\n@@\n-base\n+changed\n*** End Patch`}}],
  });
  const messages = [edit("linked", join(linked, "file.txt")), result("linked", "Success"), edit("nested", join(nested, "deleted-dir/file.txt")), result("nested", "Success")];
  const collect = () => collectGitEvidence({provider: "codex", sessionId: "worktrees", cwd: f.cwd, messages, cacheDir: join(f.temp, "contexts-cache")});
  collect();
  assert.equal(messages[0].content[0].input.patch_text.includes(join(linked, "file.txt")), true, "preserve original paths");
  assert.deepEqual(messages[0].content[0].git_repositories, [{git_root: linked, git_remote_url: "git@github.com:acme/project.git"}]);
  assert.deepEqual(messages[2].content[0].git_repositories, [{git_root: nested, git_remote_url: "git@github.com:acme/plugins.git"}]);
  const first = JSON.stringify(messages);
  collect();
  assert.equal(JSON.stringify(messages), first, "repeated capture is stable");
});

test("a mixed patch retains an unconfigured nested Git boundary", (t) => {
  const f = fixture(t);
  const nested = join(f.cwd, "nested");
  f.git("init", nested);
  const tool = {type: "tool_use", id: "mixed", name: "apply_patch", input: {patch_text: `*** Begin Patch\n*** Add File: ${f.cwd}/a.txt\n+outer\n*** Add File: ${nested}/b.txt\n+nested\n*** End Patch`}};
  const messages = [{role: "assistant", message_id: "mixed", content: [tool]}, result("mixed", "Success")];
  collectGitEvidence({provider: "codex", sessionId: "mixed", cwd: f.cwd, messages, cacheDir: join(f.temp, "mixed-cache")});
  assert.deepEqual(tool.git_repositories, [
    {git_root: f.cwd, git_remote_url: "git@github.com:acme/project.git"},
    {git_root: nested, git_remote_url: ""},
  ]);
});

test("symlink session paths do not rewrite original physical tool inputs", (t) => {
  const f = fixture(t);
  const alias = join(f.temp, "alias");
  symlinkSync(f.cwd, alias);
  const input = {file_path: join(realpathSync(f.cwd), "file.txt"), old_string: "before", new_string: "after"};
  const original = JSON.stringify(input);
  const tool = {type: "tool_use", id: "edit", name: "Edit", input};
  collectGitEvidence({provider: "codex", sessionId: "alias", cwd: alias, messages: [{role: "assistant", message_id: "edit", content: [tool]}, result("edit", "Success")], cacheDir: join(f.temp, "alias-cache")});
  assert.equal(JSON.stringify(input), original);
  assert.equal(tool.git_repositories[0].git_root, realpathSync(f.cwd));
});

for (const conflict of [false, true]) test(`captures cherry-pick${conflict ? " after conflict resolution" : " directly"} at the producing tool`, (t) => {
  const f = fixture(t);
  const base = f.commit("base");
  f.git("-C", f.cwd, "checkout", "-b", "feature");
  const source = f.commit("feature");
  f.git("-C", f.cwd, "checkout", "-b", "cloud", base.sha);
  if (conflict) f.commit("cloud");
  const pick = spawnSync("git", ["cherry-pick", source.sha], {cwd: f.cwd, encoding: "utf8"});
  assert.equal(pick.status, conflict ? 1 : 0, pick.stderr);
  const initial = call("pick", f.cwd);
  initial.content[0].input.cmd = `git cherry-pick ${source.sha}`;
  const messages = [user("request"), initial, result("pick", pick.stdout, pick.status)];
  let tool = "pick";
  if (conflict) {
    assert.equal(f.collect(messages).commits.length, 0, "the failed initial pick is not evidence");
    writeFileSync(join(f.cwd, "file.txt"), "resolved feature and cloud\n");
    const command = "git add file.txt\ngit diff --cached --check\ngit -c core.editor=true cherry-pick --continue";
    const continued = spawnSync("/bin/sh", ["-c", command], {cwd: f.cwd, encoding: "utf8"});
    assert.equal(continued.status, 0, continued.stderr);
    const finish = call("continue", f.cwd);
    finish.content[0].input.cmd = command;
    messages.push(finish, result("continue", `Process running with session ID 123\n${continued.stdout}`));
    assert.equal(f.collect(messages).commits.length, 0, "a running continuation is not yet evidence");
    const poll = call("poll", f.cwd);
    poll.content[0].name = "functions.write_stdin";
    poll.content[0].input = {process_id: 123, chars: ""};
    messages.push(poll, result("poll", "Process exited with code 0\n"));
    tool = "continue";
  }
  const captured = f.collect(messages);
  assert.equal(captured.commits.length, 1);
  assert.equal(captured.commits[0].commit_sha, f.git("-C", f.cwd, "rev-parse", "HEAD"));
  assert.equal(captured.commits[0].commit_tool_use_id, tool);
  assert.equal(captured.commits[0].start_message_id, "request");
  assert.equal(captured.commits[0].end_message_id, `${conflict ? "poll" : tool}:result`);
});

for (const mode of ["--no-commit", "--abort", "multiple"]) test(`cherry-pick ${mode} does not establish one execution`, (t) => {
  const f = fixture(t);
  const base = f.commit("base");
  f.git("-C", f.cwd, "checkout", "-b", "feature");
  const first = f.commit("first");
  const second = f.commit("second");
  f.git("-C", f.cwd, "checkout", "-b", "cloud", base.sha);
  if (mode === "--abort") {
    f.commit("conflicting cloud change");
    const conflict = spawnSync("git", ["cherry-pick", first.sha], {cwd: f.cwd, encoding: "utf8"});
    assert.equal(conflict.status, 1);
  }
  const command = mode === "multiple" ? `git cherry-pick ${first.sha} ${second.sha}`
    : mode === "--abort" ? "git cherry-pick --abort" : `git cherry-pick --no-commit ${first.sha}`;
  const executed = spawnSync("/bin/sh", ["-c", command], {cwd: f.cwd, encoding: "utf8"});
  assert.equal(executed.status, 0, executed.stderr);
  const candidate = call("pick", f.cwd);
  candidate.content[0].input.cmd = command;
  assert.equal(f.collect([user("request"), candidate, result("pick", executed.stdout)]).commits.length, 0);
});

for (const tool of ["Bash", "functions.exec_command"])
  test(`${tool}: captures a multiline commit followed by reading its SHA`, (t) => {
    const f = fixture(t);
    const first = f.commit("first");
    writeFileSync(join(f.cwd, "file.txt"), "show demo inputs\n");
    f.git("-C", f.cwd, "add", "file.txt");
    const command = 'git commit -m "chore: show demo inputs" -m "Show inputs alongside the result.\n\nKeep output readable." && git rev-parse HEAD';
    const committed = spawnSync("/bin/sh", ["-c", command], {
      cwd: f.cwd,
      encoding: "utf8",
    });
    assert.equal(committed.status, 0, committed.stderr);
    const second = call("c2", f.cwd);
    second.content[0].name = tool;
    second.content[0].input = tool === "Bash"
      ? { command, cwd: f.cwd }
      : { cmd: command, workdir: f.cwd };
    const captured = f.collect([
      user("u1"),
      call("c1", f.cwd),
      result("c1", first.output),
      user("u2"),
      second,
      result("c2", committed.stdout),
    ]);
    assert.equal(captured.commits.length, 2);
    assert.equal(captured.commits[1].commit_sha, f.git("-C", f.cwd, "rev-parse", "HEAD"));
    assert.equal(captured.commits[1].commit_tool_use_id, "c2");
    assert.equal(captured.commits[1].start_message_id, "u2");
    assert.equal(captured.commits[1].end_message_id, "c2:result");
  });

test("captures a commit surrounded by Git checks and staging", async (t) => {
  const f = fixture(t);
  const first = f.commit("base");
  writeFileSync(join(f.cwd, "file.txt"), "updated\n");
  const command = 'git -C repo diff --check\ngit -C repo status --short\ngit -C repo add file.txt\ngit -C repo diff --cached --stat\ngit -c core.quotePath=false -C repo commit -m updated';
  const executed = spawnSync("/bin/sh", ["-c", command], {cwd: f.temp, encoding: "utf8"});
  assert.equal(executed.status, 0, executed.stderr);
  const candidate = call("combined", f.cwd);
  candidate.content[0].input.cmd = command;
  candidate.content[0].input.workdir = f.temp;
  const messages = [user("u1"), call("base", f.cwd), result("base", first.output), user("u2"), candidate, result("combined", executed.stdout)];
  await traceGit(f, (trace) => {
    const captured = f.collect(messages);
    assert.equal(captured.commits.length, 2);
    assert.equal(captured.commits[1].commit_sha, f.git("-C", f.cwd, "rev-parse", "HEAD"));
    assert.equal(captured.commits[1].commit_tool_use_id, "combined");
    assert.equal(captured.commits[1].start_message_id, "u2");
    assert.equal(captured.commits[1].end_message_id, "combined:result");
    trace.clear();
    assert.deepEqual(f.collect(messages), captured);
    assert.equal(trace.calls().filter((args) => args.includes("--verify") || args[0] === "show" || args[0] === "diff-tree" || args[0] === "patch-id").length, 0, "unchanged evidence does not revalidate Git objects");
  });
});

for (const outcome of ["success", "success without errexit", "push fails", "precheck skips commit", "inspection prints old SHA", "push masks failed commit"]) test(`combined Git commit and push: ${outcome}`, (t) => {
  const fixtureRepo = fixture(t);
  const { cwd, git } = fixtureRepo;
  const base = fixtureRepo.commit("base");
  const remote = join(fixtureRepo.temp, "origin.git");
  git("init", "--bare", remote);
  git("-C", cwd, "remote", "set-url", "origin", remote);
  git("-C", cwd, "push", "-u", "origin", "main");
  if (outcome === "push fails") git("-C", cwd, "remote", "set-url", "--push", "origin", join(fixtureRepo.temp, "missing.git"));
  const masked = outcome === "push masks failed commit";
  if (!masked) writeFileSync(join(cwd, "file.txt"), "updated\n");
  const skipped = outcome === "precheck skips commit" || outcome === "inspection prints old SHA";
  const command = [
    ...(outcome === "success without errexit" || masked ? [] : ["set -e"]),
    "git add -- file.txt",
    "git diff --cached --check",
    "git diff --cached --name-status",
    ...(outcome === "inspection prints old SHA" || masked ? ["git log -1 --format='[main %h] %s'"] : []),
    ...(skipped ? ["git merge-base --is-ancestor missing HEAD"] : []),
    "git commit -m updated",
    ...(!masked ? ["git merge-base --is-ancestor origin/main HEAD"] : []),
    "git push origin HEAD:refs/heads/main",
    ...(!masked ? ["git ls-remote --exit-code origin refs/heads/main"] : []),
    "git status --short --branch",
  ].join("\n");
  const executed = spawnSync("/bin/sh", ["-c", command], { cwd, encoding: "utf8" });
  assert.ifError(executed.error);
  assert.equal(executed.status === 0, outcome.startsWith("success") || masked, executed.stderr);
  const sha = git("-C", cwd, "rev-parse", "HEAD");
  assert.equal(sha === base.sha, skipped || masked);
  const tool = call("combined", cwd);
  tool.content[0].input.cmd = command;
  const poll = call("poll", cwd);
  poll.content[0].name = "functions.write_stdin";
  poll.content[0].input = { session_id: 123, chars: "" };
  const terminal = result("poll", executed.stderr, executed.status);
  if (executed.status) terminal.content[0].run.status = "error";
  const partial = [user("request"), tool, result("combined", `Process running with session ID 123\n${executed.stdout}`)];
  const incomplete = fixtureRepo.collect(partial);
  assert.deepEqual(incomplete.commits, []);
  assert.deepEqual(incomplete.commit_references, []);
  const captured = fixtureRepo.collect([...partial, poll, terminal]);
  assert.deepEqual(captured.commits.map(claim => claim.commit_sha), outcome === "success" ? [sha] : []);
  assert.deepEqual(captured.commit_references.map(claim => claim.commit_sha), outcome === "push fails" || outcome === "success without errexit" ? [sha] : []);
  assert.equal(captured.commits_complete, outcome === "success");
  if (!skipped && !masked) {
    const claim = captured.commits[0] ?? captured.commit_references[0];
    assert.equal(claim.commit_tool_use_id, "combined");
    assert.equal(claim.end_message_id, "poll:result");
  }
  if (outcome === "push fails") {
    poll.content[0].input.session_id = 456;
    assert.deepEqual(fixtureRepo.collect([...partial, poll, terminal]).commit_references, []);
  }
});

for (const finish of ["success", "wrong session", "failure"]) test(`cherry-pick with piped checks and repeated polls: ${finish}`, (t) => {
  const f = fixture(t);
  const base = f.commit("base");
  f.git("-C", f.cwd, "checkout", "-b", "feature");
  const source = f.commit("feature");
  f.git("-C", f.cwd, "checkout", "-b", "cloud", base.sha);
  const command = `git cherry-pick ${source.sha} && git diff HEAD~ HEAD | head -24 && git status --short > check.log 2>&1`;
  const executed = spawnSync("/bin/sh", ["-c", command], {cwd: f.cwd, encoding: "utf8"});
  assert.equal(executed.status, 0, executed.stderr);
  const candidate = call("pick", f.cwd);
  candidate.content[0].input.cmd = command;
  const messages = [user("request"), candidate, result("pick", "Process running with session ID 123\n")];
  assert.equal(f.collect(messages).commits.length, 0, "a success header alone does not establish shell completion");
  const progress = call("progress", f.cwd);
  progress.content[0].name = "functions.write_stdin";
  progress.content[0].input = {process_id: 123, chars: ""};
  messages.push(progress, result("progress", `Process running with session ID 123\n${executed.stdout}`));
  assert.equal(f.collect(messages).commits.length, 0, "even a success header in a later poll needs completion");
  const poll = call("poll", f.cwd);
  poll.content[0].name = "functions.write_stdin";
  poll.content[0].input = {process_id: finish === "wrong session" ? 999 : 123, chars: ""};
  const exitCode = finish === "failure" ? 1 : 0;
  messages.push(poll, result("poll", `Process exited with code ${exitCode}\n`, exitCode));
  const captured = f.collect(messages);
  if (finish !== "success") {
    assert.equal(captured.commits.length, 0, "unrelated or failed completions cannot confirm the Git operation");
    return;
  }
  assert.equal(captured.commits.length, 1);
  assert.equal(captured.commits[0].commit_sha, f.git("-C", f.cwd, "rev-parse", "HEAD"));
  assert.equal(captured.commits[0].commit_tool_use_id, "pick");
  assert.equal(captured.commits[0].start_message_id, "request");
  assert.equal(captured.commits[0].end_message_id, "poll:result");
});

test("captures the cherry-pick, search, and Go test command shape with real tools", (t) => {
  for (const tool of ["rg", "go"]) {
    if (spawnSync(tool, [tool === "go" ? "version" : "--version"]).status !== 0) {
      t.skip(`${tool} is needed for this integration check`);
      return;
    }
  }
  const f = fixture(t);
  const base = f.commit("base");
  f.git("-C", f.cwd, "checkout", "-b", "feature");
  const source = f.commit("feature");
  f.git("-C", f.cwd, "checkout", "-b", "cloud", base.sha);
  writeFileSync(join(f.cwd, "go.mod"), "module example.test/provenance\n\ngo 1.20\n");
  writeFileSync(join(f.cwd, "example_test.go"), "package provenance\nimport \"testing\"\nfunc TestExample(t *testing.T) {}\n");
  const command = `git cherry-pick ${source.sha} && rg -n feature file.txt | head -24 && go test ./... -count=1 > check.log 2>&1`;
  const executed = spawnSync("/bin/sh", ["-c", command], {cwd: f.cwd, encoding: "utf8"});
  assert.equal(executed.status, 0, executed.stderr + readFileSync(join(f.cwd, "check.log"), "utf8"));
  const candidate = call("pick", f.cwd);
  candidate.content[0].input.cmd = command;
  const messages = [user("request"), candidate, result("pick", executed.stdout)];
  const captured = f.collect(messages);
  assert.equal(captured.commits[0]?.commit_sha, f.git("-C", f.cwd, "rev-parse", "HEAD"));
  messages[2] = result("pick", executed.stdout, 1);
  assert.equal(f.collect(messages).commits.length, 0, "failed combined checks do not confirm execution");
});

test("two same-repository commits in one success chain share a valid interval", (t) => {
  const f = fixture(t);
  const base = f.commit("base");
  writeFileSync(join(f.cwd, "file.txt"), "second\n");
  f.git("-C", f.cwd, "add", "file.txt");
  const command = 'git commit -m second && git commit --allow-empty -m third && git rev-parse HEAD';
  const executed = spawnSync("/bin/sh", ["-c", command], {cwd: f.cwd, encoding: "utf8"});
  assert.equal(executed.status, 0, executed.stderr);
  const candidate = call("batch", f.cwd);
  candidate.content[0].input.cmd = command;
  const captured = f.collect([user("u1"), call("base", f.cwd), result("base", base.output), user("u2"), candidate, result("batch", executed.stdout)]);
  assert.deepEqual(captured.commits.map(c => c.commit_sha), [base.sha, f.git("-C", f.cwd, "rev-parse", "HEAD^"), f.git("-C", f.cwd, "rev-parse", "HEAD")]);
  assert.ok(captured.commits.slice(1).every(c => c.start_message_id === "u2" && c.end_message_id === "batch:result"));
});

test("ambiguous or incomplete batch summaries cannot establish multiple commits", (t) => {
  const f = fixture(t);
  const first = f.commit("first"), second = f.commit("second");
  const candidate = call("batch", f.cwd);
  candidate.content[0].input.cmd = "set -e\ngit commit -m first\ngit commit -m second";
  for (const output of [first.output, first.output + "\n" + second.output + "\n" + second.output,
    first.output + "\n" + first.output,
    first.output + `\n[main ${first.sha}] same object with a longer prefix`]) {
    assert.equal(f.collect([user("u"), candidate, result("batch", output)]).commits.length, 0);
  }
});

test("unsupported shell structures and quoted code do not become executed evidence", (t) => {
  const f = fixture(t);
  const first = f.commit("first");
  const sentinel = join(f.temp, "must-not-be-created");
  for (const command of [
    "if git diff --quiet; then git commit -m hidden; fi",
    "commit_later() { git commit -m hidden; }",
    "cat <<'EOF'\ngit commit -m hidden\nEOF",
    "! git commit -m hidden",
    "git commit -m hidden &",
    "git commit -m hidden > hidden.log",
    `git commit -m "$(touch '${sentinel}')"`,
    'git commit -m "unterminated',
    "git commit -m unfinished &&",
  ]) {
    const candidate = call("unsupported", f.cwd);
    candidate.content[0].input.cmd = command;
    assert.equal(f.collect([candidate, result("unsupported", first.output)]).commits.length, 0, command);
    assert.equal(existsSync(sentinel), false, "transcript substitutions are never executed");
  }
});

for (const scenario of [
  {
    name: "a skipped set -e before a failed commit and an old summary",
    stage: false,
    command: () => "git rev-parse --verify missing-ref && set -e\ngit commit -m nonexistent\ngit log -1 --format='[main %h] old'",
  },
  {
    name: "a loop whose later literal binding stages files",
    stage: false,
    command: () => 'set -e\ngit commit --allow-empty -m explicit\nfor action in status add; do git "$action" -- .; done',
  },
  {
    name: "set -e masking a failed nonfinal success chain before an old summary",
    stage: false,
    command: () => "set -e\ngit commit -m second && git status --short\ngit log -1 --format='[main %h] old'",
  },
  {
    name: "set -e skipping a producer after a failed check before an old summary",
    stage: false,
    command: () => "set -e\ngit rev-parse --verify missing-ref && git commit -m second\ngit log -1 --format='[main %h] old'",
  },
  {
    name: "failed commit followed by a printed old SHA after an escaped quote",
    stage: false,
    command: (sha) => String.raw`git commit -m "x\"" ; printf "[main ${sha.slice(0, 8)}] old\n"`,
  },
  {
    name: "dynamic commit arguments followed by reading HEAD",
    stage: true,
    command: () => 'git commit -m "$(git rev-parse --short HEAD)" && git rev-parse HEAD',
  },
  {
    name: "a commit piped into an output filter",
    stage: true,
    command: () => 'git commit -m second | head -24',
  },
  {
    name: "an arbitrary output command after a failed commit",
    stage: false,
    command: (sha) => `git commit -m second\nprintf '[main ${sha.slice(0, 8)}] old'`,
  },
  {
    name: "head replaying an old summary after a failed commit",
    stage: false,
    command: () => "git commit -m second\nhead -24 old.log",
    replayOldSummary: true,
  },
  ...["-q", "--qui", "-aq", "--porcelain", "--dry"].map((option) => ({
    name: `a ${option} commit followed by an old summary`,
    stage: true,
    command: () => `git commit ${option} -m second && head -24 old.log`,
    replayOldSummary: true,
  })),
  {
    name: "a redirected commit with the redirect between its message option and value",
    stage: true,
    command: () => "git commit -m > actual.log second && head -1 old.log",
    replayOldSummary: true,
  },
]) test(`rejects ${scenario.name}`, (t) => {
  const f = fixture(t);
  const first = f.commit("first");
  if (scenario.replayOldSummary) writeFileSync(join(f.cwd, "old.log"), first.output + "\n");
  if (scenario.stage) {
    writeFileSync(join(f.cwd, "file.txt"), "second\n");
    f.git("-C", f.cwd, "add", "file.txt");
  }
  const command = scenario.command(first.sha);
  const executed = spawnSync("/bin/sh", ["-c", command], {
    cwd: f.cwd,
    encoding: "utf8",
  });
  assert.equal(executed.status, 0, executed.stderr);
  const candidate = call("c", f.cwd);
  candidate.content[0].input.cmd = command;
  const captured = f.collect([user("u"), candidate, result("c", executed.stdout)]);
  assert.equal(captured.commits.length, 0, "an overall zero exit and real objects do not establish unique commit evidence");
});

test("cached object verification recomputes ranges when an earlier successful commit becomes available", (t) => {
  const f = fixture(t);
  const first = f.commit("first"),
    second = f.commit("second");
  const messages = [
    user("u1"),
    call("c1", f.cwd),
    result("c1", first.output, 1),
    user("u2"),
    call("c2", f.cwd),
    result("c2", second.output),
  ];
  const initial = f.collect(messages);
  assert.equal(initial.commits.length, 1);
  assert.equal(initial.commits[0].start_message_id, "u1");
  messages[2] = result("c1", first.output);
  const restored = f.collect(messages);
  assert.equal(restored.commits.length, 2);
  assert.equal(restored.commits[1].start_message_id, "u2");
});

test("amend inherits observed replaced commit range but failed and echo commands are not evidence", async (t) => {
  const f = fixture(t);
  const first = f.commit("first");
  writeFileSync(join(f.cwd, "file.txt"), "amended\n");
  f.git("-C", f.cwd, "add", ".");
  const output = f.git("-C", f.cwd, "commit", "--amend", "-m", "amended");
  const amend = call("amend", f.cwd);
  amend.content[0].input.cmd = `git -C "${f.cwd}" commit --amend -m amended`;
  const echo = call("echo", f.cwd);
  echo.content[0].input.cmd = 'echo "git commit"';
  const messages = [
    user("u1"),
    call("c1", f.cwd),
    result("c1", first.output),
    user("u2"),
    amend,
    result("amend", output),
    echo,
    result("echo", first.output),
  ];
  await traceGit(f, async (trace) => {
    const captured = f.collect(messages);
    assert.equal(captured.commits.length, 2);
    assert.equal(captured.commits[1].superseded_sha, first.sha);
    assert.equal(captured.commits[1].start_message_id, "u1");
    assert.equal(
      trace.calls().filter((args) => args[0] === "reflog").length,
      1,
      "an amend only needs one reflog read",
    );
  });
});

test("an amend followed by another commit in the same tool retains its replaced range", (t) => {
  const f = fixture(t);
  const first = f.commit("first");
  const command = "git commit --amend --allow-empty -m amended && git commit --allow-empty -m after";
  const executed = spawnSync('/bin/sh', ['-c', command], {cwd:f.cwd, encoding:'utf8'});
  assert.equal(executed.status, 0, executed.stderr);
  const candidate = call("batch", f.cwd);
  candidate.content[0].input.cmd = command;
  const captured = f.collect([user("u1"), call("first", f.cwd), result("first", first.output), user("u2"), candidate, result("batch", executed.stdout)]);
  assert.equal(captured.commits.length, 3);
  assert.equal(captured.commits[1].superseded_sha, first.sha);
  assert.equal(captured.commits[1].start_message_id, "u1");
  assert.equal(captured.commits[2].start_message_id, "u1");
  assert.equal(captured.commits[2].superseded_sha, "");
});

for (const shared of [false, true])
  test(`failed Diff is retried after a missing blob returns${shared ? " to a shared object store" : ""}`, (t) => {
    const f = fixture(t);
    const commit = f.commit("blob-content");
    const blob = f.git("-C", f.cwd, "rev-parse", "HEAD:file.txt");
    assert.notEqual(
      commit.sha.slice(0, 2),
      blob.slice(0, 2),
      "fixture must exercise another object bucket",
    );
    const object = join(
      f.cwd,
      ".git",
      "objects",
      blob.slice(0, 2),
      blob.slice(2),
    );
    const target = shared ? join(f.temp, "shared") : f.cwd;
    if (shared) f.git("clone", "--shared", f.cwd, target);
    const messages = [user("u"), call("c", target), result("c", commit.output)];
    const collect = () =>
      collectGitEvidence({
        provider: "codex",
        sessionId: "blob",
        cwd: target,
        messages,
        cacheDir: join(f.temp, "blob-cache"),
      });
    renameSync(object, join(f.temp, "held-blob"));
    assert.equal(collect().commits.length, 0);
    renameSync(join(f.temp, "held-blob"), object);
    const recovered = collect();
    assert.equal(recovered.commits.length, 1);
    assert.equal(recovered.commits[0].commit_sha, commit.sha);
  });

test("a temporarily unavailable shared object store stays incomplete and recovers", (t) => {
  const f = fixture(t);
  const commit = f.commit("shared-store");
  const target = join(f.temp, "dependent");
  f.git("clone", "--shared", f.cwd, target);
  const messages = [user("u"), call("c", target), result("c", commit.output)];
  const collect = () =>
    collectGitEvidence({
      provider: "codex",
      sessionId: "offline",
      cwd: target,
      messages,
      cacheDir: join(f.temp, "offline-cache"),
    });
  const offline = join(f.temp, "offline");
  renameSync(f.cwd, offline);
  const missing = collect();
  assert.equal(missing.commits.length, 0);
  assert.equal(missing.commits_complete, false);
  renameSync(offline, f.cwd);
  const recovered = collect();
  assert.equal(recovered.commits[0].commit_sha, commit.sha);
  assert.equal(recovered.commits_complete, true);
});

for (const restore of ["loose", "pack"])
  test(`unchanged failed candidates are skipped until ${restore} objects arrive`, async (t) => {
    const f = fixture(t);
    const base = f.commit("base");
    const candidate = f.commit("arriving");
    const object = join(
      f.cwd,
      ".git",
      "objects",
      candidate.sha.slice(0, 2),
      candidate.sha.slice(2),
    );
    const bytes = readFileSync(object);
    const pack = spawnSync("git", ["-C", f.cwd, "pack-objects", "--stdout"], {
      input: candidate.sha + "\n",
    });
    assert.equal(pack.status, 0);
    renameSync(object, join(f.temp, "held-object"));
    const messages = [
      user("u1"),
      call("c1", f.cwd),
      result("c1", candidate.output),
      call("c2", f.cwd),
      result("c2", candidate.output),
    ];
    await traceGit(f, async (trace) => {
      const first = f.collect(messages);
      assert.equal(first.commits.length, 0);
      trace.clear();
      messages.push(user("ordinary-append"));
      const unchanged = f.collect(messages);
      assert.equal(unchanged.commits.length, 0);
      assert.equal(
        trace.calls().filter((args) => args.includes("--verify")).length,
        0,
        "unchanged failures must not revalidate each old candidate",
      );
      assert.equal(first.commits_complete, false);
      assert.equal(unchanged.commits_complete, false);
      // A changed terminal result retries its tool even when repository storage is unchanged.
      trace.clear();
      const updated = [...messages];
      updated[4] = result("c2", base.output);
      const changed = f.collect(updated);
      assert.equal(changed.commits.length, 1);
      assert.equal(changed.commits[0].commit_sha, base.sha);
      assert.equal(
        trace.calls().filter((args) => args.includes("--verify")).length,
        1,
      );
      if (restore === "loose") writeFileSync(object, bytes);
      else {
        const imported = spawnSync(
          "git",
          ["-C", f.cwd, "index-pack", "--stdin"],
          { input: pack.stdout },
        );
        assert.equal(imported.status, 0);
      }
      trace.clear();
      const recovered = f.collect(messages);
      assert.equal(recovered.commits.length, 2);
      assert.equal(recovered.commits_complete, true);
      assert.equal(recovered.commits[0].commit_sha, candidate.sha);
    });
  });

for (const fileOption of ['-F -', '--file -', '-F-', '--file=-']) {
  test(`collects a literal stdin heredoc commit using ${fileOption}`, (t) => {
    const f = fixture(t);
    f.commit('base');
    const command = `set -e\ngit commit --allow-empty ${fileOption} <<-'MESSAGE'\n\tfeat: literal input\n\n\tgit commit -m not-executed\n\t$(touch must-not-exist)\nMESSAGE\ngit status --short`;
    const executed = spawnSync('/bin/sh', ['-c', command], {cwd:f.cwd, encoding:'utf8'});
    assert.equal(executed.status, 0, executed.stderr);
    const candidate = call('stdin', f.cwd);
    candidate.content[0].input.cmd = command;
    const captured = f.collect([user('u'), candidate, result('stdin', executed.stdout)]);
    assert.equal(captured.commits.length, 1);
    assert.equal(captured.commits[0].commit_sha, f.git('-C', f.cwd, 'rev-parse', 'HEAD'));
    assert.equal(existsSync(join(f.cwd, 'must-not-exist')), false);
  });
}

for (const finalCommand of [
  'git commit --allow-empty -F message.txt',
  'git diff --check && git commit --allow-empty -F message.txt && git commit --allow-empty -m second',
]) test(`collects Python preparation followed by ${finalCommand}`, (t) => {
  const f = fixture(t);
  f.commit('base');
  const command = `python3 - <<'PY'\nfrom pathlib import Path\nPath('message.txt').write_text('feat: prepared message\\n\\ngit commit -m only-data\\n')\nPY\n${finalCommand}`;
  const executed = spawnSync('/bin/sh', ['-c', command], { cwd: f.cwd, encoding: 'utf8' });
  assert.equal(executed.status, 0, executed.stderr);
  const candidate = call('python', f.cwd);
  candidate.content[0].input.cmd = command;
  const captured = f.collect([user('u'), candidate, result('python', executed.stdout)]);
  const expected = finalCommand.includes('-m second')
    ? [f.git('-C', f.cwd, 'rev-parse', 'HEAD^'), f.git('-C', f.cwd, 'rev-parse', 'HEAD')]
    : [f.git('-C', f.cwd, 'rev-parse', 'HEAD')];
  assert.deepEqual(captured.commits.map(c => c.commit_sha), expected);
  assert.ok(captured.commits.every(c => c.commit_tool_use_id === 'python' && c.start_message_id === 'u'));
});

test('rejects unsupported stdin and preparation boundaries even with a real commit summary', (t) => {
  const f = fixture(t);
  const base = f.commit('base');
  const prep = "python3 - <<'PY'\npass\nPY\n";
  for (const command of [
    'git commit -F - <<EOF\nmessage\nEOF',
    "git commit -F - 3<<'EOF'\nmessage\nEOF",
    "git commit -F - {fd}<<'EOF'\nmessage\nEOF",
    "git commit -F - <<'A' <<'B'\none\nA\ntwo\nB",
    "git commit -F - <<'EOF' >output\nmessage\nEOF",
    "git commit -F - <<'EOF' 2>&1\nmessage\nEOF",
    "git commit -m '-F-' <<'EOF'\nmessage\nEOF",
    "git commit --file=- --file=message.txt <<'EOF'\nmessage\nEOF",
    "git commit -F - <<'EOF'\nunterminated",
    'python3 - <<PY\npass\nPY\ngit commit -m change',
    "python3 - {fd}<<'PY'\npass\nPY\ngit commit -m change",
    "python3 -c 'pass'\ngit commit -m change",
    "python3 - <<'PY' && git commit -m change\npass\nPY",
    `set -e\ngit commit -m change\n${prep}`,
    `set -e\n${prep}git commit -m change\ngit status --short`,
    `${prep}git commit -m change && git status --short`,
    `${prep}git commit -m change | head`,
    `${prep}git commit -m change &`,
    `${prep}git commit -m "$SUBJECT"`,
  ]) {
    const candidate = call('boundary', f.cwd);
    candidate.content[0].input.cmd = command;
    assert.equal(f.collect([user('u'), candidate, result('boundary', base.output)]).commits.length, 0, command);
  }
});

test('Python preparation cannot mask failed or skipped commits or add ambiguous summaries', (t) => {
  const f = fixture(t);
  const base = f.commit('base');
  writeFileSync(join(f.cwd, 'old.log'), base.output + '\n');
  const prep = "python3 - <<'PY'\nfrom pathlib import Path\nprint(Path('old.log').read_text(), end='')\nPY\n";
  for (const [command, exitCode] of [
    [prep + 'git commit -m no-changes', 1],
    [prep + 'git commit -m no-changes\ngit status --short', 0],
    ['set -e\n' + prep + 'git rev-parse --verify missing-ref && git commit -m skipped\ngit status --short', 0],
    [prep + 'git commit --allow-empty -m actual', 0],
  ]) {
    const executed = spawnSync('/bin/sh', ['-c', command], { cwd: f.cwd, encoding: 'utf8' });
    assert.equal(executed.status, exitCode, executed.stderr);
    const candidate = call('ambiguous-python', f.cwd);
    candidate.content[0].input.cmd = command;
    assert.equal(f.collect([user('u'), candidate, result('ambiguous-python', executed.stdout, executed.status)]).commits.length, 0, command);
  }
});

test('repository activity and strict commits follow literal cd without leaking between calls', t => {
  const f = fixture(t);
  const committed = f.commit('directory ownership');
  const candidate = call('cd', f.temp);
  candidate.content[0].input.cmd = 'cd repo && git commit -m "directory ownership"';
  const inspect = call('inspect', f.temp);
  inspect.content[0].input.cmd = 'git status --short';
  const captured = f.collect([candidate, result('cd', committed.output), inspect, result('inspect', '')]);
  assert.equal(captured.commits[0]?.commit_sha, committed.sha);
  assert.ok(captured.repositories.some(r => r.git_root === f.cwd && r.tool_use_id === 'cd' && r.message_id === 'cd'));
  assert.ok(!captured.repositories.some(r => r.tool_use_id === 'inspect'));
});

test('explicit unsupported commit modes cannot be rescued as output references', t => {
  const f = fixture(t), committed = f.commit('real object');
  for (const command of ['git commit --dry-run', 'git cherry-pick --abort', 'git commit -m "$MESSAGE"', 'echo spoof; git commit -m change', 'git log --format="[main %h] %s"']) {
    const candidate = call('unsupported', f.cwd);
    candidate.content[0].input.cmd = command;
    const captured = f.collect([candidate, result('unsupported', committed.output)]);
    assert.deepEqual(captured.commit_references, [], command);
  }
});

test('masked failures and unsafe directory control flow do not establish repository activity', t => {
  const f = fixture(t);
  f.commit('base');
  for (const command of [
    'git -C repo rev-parse missing-ref; true',
    'false && git -C repo status; true',
    'cd repo; git status',
    'cd "$TARGET" && git status',
    'cd missing || cd repo; git status',
    'if true; then cd repo; fi; git status',
    '(cd repo); git status',
  ]) {
    const candidate = call('unsafe-cwd', f.temp);
    candidate.content[0].input.cmd = command;
    const captured = f.collect([candidate, result('unsafe-cwd', '')]);
    assert.deepEqual(captured.repositories, [], command);
  }
});

for (const python of ['python3', '.venv/bin/python']) test(`${python}: opaque completed producer yields only object-checked output references`, t => {
  const f = fixture(t);
  const committed = f.commit('opaque child');
  const candidate = call('opaque', f.cwd);
  candidate.content[0].input.cmd = `${python} - <<'PY'\nimport subprocess\nsubprocess.run(['git', 'commit', '-m', 'opaque child'], check=True)\nPY\ngit push origin main`;
  const captured = f.collect([user('u'), candidate, result('opaque', committed.output)]);
  assert.deepEqual(captured.commits, []);
  assert.equal(captured.commit_references[0]?.commit_sha, committed.sha);
  assert.equal(captured.commit_references[0]?.commit_tool_use_id, 'opaque');
  assert.equal(captured.commit_references[0]?.commit_message_id, 'opaque');
  assert.equal(captured.commits_complete, false);
  assert.ok(captured.diagnostics.some(d => d.code === 'unsupported_producer'));
  assert.deepEqual(f.collect([user('u'), candidate, result('opaque', committed.output)]), captured);
  assert.deepEqual(f.collect([candidate, result('opaque', committed.output, 1)]).commit_references, [], 'failed whole tool is never promoted');
  assert.deepEqual(f.collect([candidate, result('opaque', committed.output.replace('opaque child', 'wrong subject'))]).commit_references, []);
  assert.deepEqual(f.collect([candidate, result('opaque', committed.output + '\n' + committed.output)]).commit_references, [], 'duplicate summaries are ambiguous');
  const other = join(f.temp, 'other');
  f.git('init', other);
  f.git('-C', other, 'remote', 'add', 'origin', 'git@github.com:acme/other.git');
  candidate.content[0].input.cmd += `\ngit -C "${other}" status --short`;
  assert.deepEqual(f.collect([candidate, result('opaque', committed.output)]).commit_references, [], 'multiple target repos are ambiguous');
});

test('missing opaque producer objects report incompleteness and retry when the object returns', t => {
  const f = fixture(t), committed = f.commit('restored object');
  const object = join(f.cwd, '.git/objects', committed.sha.slice(0, 2), committed.sha.slice(2));
  const backup = join(f.temp, 'object-backup');
  const candidate = call('opaque-missing', f.cwd);
  candidate.content[0].input.cmd = "python3 - <<'PY'\npass\nPY";
  const messages = [candidate, result('opaque-missing', committed.output)];
  renameSync(object, backup);
  const missing = f.collect(messages);
  assert.deepEqual(missing.commit_references, []);
  assert.equal(missing.commits_complete, false);
  assert.ok(missing.diagnostics.some(d => d.code === 'object_lookup_failed'));
  assert.deepEqual(f.collect(messages), missing);
  renameSync(backup, object);
  assert.equal(f.collect(messages).commit_references[0]?.commit_sha, committed.sha);
});

test('diagnostics are bounded and never turn incomplete replay into a full replacement', t => {
  const f = fixture(t);
  const messages = [];
  for (let i = 0; i < 110; i++) {
    const candidate = call(`unsupported-${i}`, f.cwd);
    candidate.content[0].input.cmd = 'git commit --dry-run';
    messages.push(candidate, result(`unsupported-${i}`, ''));
  }
  const captured = f.collect(messages);
  assert.equal(captured.diagnostics.length, 100);
  assert.ok(captured.diagnostics.some(d => d.code === "diagnostics_truncated"));
  assert.equal(captured.commits_complete, false);
});

test('a skipped errexit cannot prove earlier repository activity', t => {
  const f = fixture(t);
  const candidate = call('skipped-set', f.temp);
  candidate.content[0].input.cmd = 'false && set -e\ngit -C repo rev-parse missing-ref\ntrue';
  assert.deepEqual(f.collect([candidate, result('skipped-set', '')]).repositories, []);
});

test('reused polling handles do not leak old commit summaries into another execution', t => {
  const f = fixture(t), first = f.commit('one'), second = f.commit('two');
  const poll = (id) => ({role:'assistant', message_id:id, content:[{type:'tool_use', id, name:'write_stdin', input:{session_id:12, chars:''}}]});
  const messages = [call('one', f.cwd), result('one', `Process running with session ID 12\n${first.output}`), poll('end-one'), result('end-one', ''),
    call('two', f.cwd), result('two', `Process running with session ID 12\n${second.output}`), poll('end-two'), result('end-two', '')];
  assert.deepEqual(f.collect(messages).commits.map(c => c.commit_sha), [first.sha, second.sha]);
});

test('relative tool cwd and linked/nested read-only Git activity use the actual repository boundary', t => {
  const f = fixture(t);
  f.commit('base');
  const linked = join(f.temp, 'linked');
  f.git('-C', f.cwd, 'worktree', 'add', '-b', 'activity', linked);
  const nested = join(linked, 'nested');
  f.git('init', nested);
  f.git('-C', nested, 'remote', 'add', 'origin', 'git@github.com:acme/nested.git');
  const candidate = call('relative', f.temp);
  candidate.timestamp_ms = 1794877200000;
  candidate.content[0].input = {cmd:'git status --short', cwd:'repo'};
  const activity = call('linked-read', linked);
  activity.content[0].input.cmd = 'git -C nested status --short';
  const captured = f.collect([candidate, result('relative', ''), activity, result('linked-read', '')]);
  assert.ok(captured.repositories.some(r => r.git_root === f.cwd && r.tool_use_id === 'relative' && r.event_ms === 1794877200000));
  assert.ok(captured.repositories.some(r => r.git_root === nested && r.git_remote_url === 'git@github.com:acme/nested.git' && r.tool_use_id === 'linked-read'));
  assert.deepEqual(captured.commit_references, []);
  const initial = collectGitEvidence({provider:'codex', sessionId:'initial', cwd:linked, messages:[], cacheDir:join(f.temp, 'initial-cache')});
  assert.deepEqual(initial.repositories, [{git_root:linked, git_remote_url:'git@github.com:acme/project.git'}]);
});

test('shell termination and directory-changing builtins cannot make skipped tools into activity', t => {
  const f = fixture(t);
  for (const prefix of ['exit 0', 'exec true', 'eval "cd repo"', 'source setup.sh', 'pushd repo']) {
    const candidate = call('terminate', f.temp);
    candidate.content[0].input.cmd = `${prefix}; git -C repo status --short`;
    assert.deepEqual(f.collect([candidate, result('terminate', '')]).repositories, [], prefix);
  }
});

test('repository activity upload caps distinct repositories at 256 with a truncation diagnostic', t => {
  const f = fixture(t), messages = [];
  for (let i = 0; i < 257; i++) {
    const repo = join(f.temp, `repository-${i}`);
    f.git('init', repo);
    const candidate = call(`activity-${i}`, repo);
    candidate.content[0].input.cmd = 'git status --short';
    messages.push(candidate, result(`activity-${i}`, ''));
  }
  const p = f.collect(messages);
  assert.equal(p.repositories.length, 256);
  assert.equal(p.commits_complete, false);
  assert.ok(p.diagnostics.some(d => d.code === 'repositories_truncated' && d.tool_use_id === 'activity-256'));
});

test('output references upload is capped at 500 with real unique Git objects', {skip: !process.env.JIELI_PROVENANCE_LIMIT_TEST}, t => {
  const f = fixture(t);
  const base = f.commit('base');
  const tree = f.git('-C', f.cwd, 'rev-parse', `${base.sha}^{tree}`);
  const summaries = [];
  for (let i = 0; i < 501; i++) {
    const sha = f.git('-C', f.cwd, 'commit-tree', tree, '-p', base.sha, '-m', `reference ${i}`);
    summaries.push(`[main ${sha}] reference ${i}`);
  }
  const candidate = call('reference-limit', f.cwd);
  candidate.content[0].input.cmd = "python3 - <<'PY'\npass\nPY";
  const p = f.collect([candidate, result('reference-limit', summaries.join('\n'))]);
  assert.equal(p.commit_references.length, 500);
  assert.equal(p.commits_complete, false);
  assert.ok(p.diagnostics.some(d => d.code === 'commit_references_truncated'));
});

test('a partial replay cannot revoke previously captured verified producer evidence', t => {
  const f = fixture(t), committed = f.commit('observed earlier');
  const candidate = call('partial', f.cwd);
  assert.equal(f.collect([candidate, result('partial', committed.output)]).commits.length, 1);
  for (const messages of [[candidate], [candidate, result('partial', 'Process running with session ID 44\n')]]) {
    const partial = f.collect(messages);
    assert.equal(partial.commits_complete, false);
    assert.ok(partial.diagnostics.some(d => d.code === 'producer_not_completed'));
  }
});

test('repeated activity preserves first/last anchors without starving a distinct repository', t => {
  const f = fixture(t), messages = [];
  const other = join(f.temp, 'other');
  f.git('init', other);
  for (let i = 0; i < 260; i++) {
    const candidate = call(`repeat-${i}`, f.cwd);
    candidate.content[0].input.cmd = 'git status --short';
    messages.push(candidate, result(`repeat-${i}`, ''));
  }
  const candidate = call('distinct', other);
  candidate.content[0].input.cmd = 'git status --short';
  messages.push(candidate, result('distinct', ''));
  const p = f.collect(messages);
  assert.deepEqual(p.repositories.map(r => r.tool_use_id), ['repeat-0', 'distinct', 'repeat-259']);
  assert.equal(p.commits_complete, true);
});

for (const variant of [
  'no-pager', 'pager-short', 'global-flags', 'repository-equals',
  'repository-separated', 'namespace-value', 'config-env', 'mixed-C-c',
  'bare-worktree', 'absolute-binary', 'absolute-global',
]) test(`unsupported Git producer stays incomplete without new claims: ${variant}`, t => {
  const f = fixture(t), retained = f.commit('retained');
  const absoluteGit = spawnSync('which', ['git'], {encoding:'utf8'}).stdout.trim();
  const options = {
    'no-pager': ['--no-pager'],
    'pager-short': ['-P'],
    'global-flags': ['--no-optional-locks', '--no-replace-objects', '--no-lazy-fetch', '--no-advice', '--literal-pathspecs'],
    'repository-equals': [`--git-dir=${f.cwd}/.git`, `--work-tree=${f.cwd}`],
    'repository-separated': ['--git-dir', `${f.cwd}/.git`, '--work-tree', f.cwd],
    'namespace-value': ['--namespace', 'commit'],
    'config-env': ['--config-env=user.name=GIT_AUTHOR_DATE'],
    'mixed-C-c': ['--no-pager', '-C', f.cwd, '-c', 'core.quotePath=false'],
    'bare-worktree': ['--bare', `--git-dir=${f.cwd}/.git`, `--work-tree=${f.cwd}`],
    'absolute-binary': [],
    'absolute-global': ['--no-pager', '-C', f.cwd],
  }[variant];
  const executable = variant.startsWith('absolute-') ? absoluteGit : 'git';
  const command = (action, args) => [executable, ...options, action, ...args].map(word => JSON.stringify(word)).join(' ');
  const prior = [call('retained', f.cwd), result('retained', retained.output)];
  assert.equal(f.collect(prior).commits[0]?.commit_sha, retained.sha);
  // Fixture-owned Git invocation: never execute the command string under test.
  const output = f.git('-C', f.cwd, ...options, 'commit', '--allow-empty', '-m', 'change');
  const candidate = call('unsupported-global', f.cwd);
  candidate.content[0].input.cmd = command('commit', ['--allow-empty', '-m', 'change']);
  const captured = f.collect([...prior, candidate, result('unsupported-global', output)]);
  assert.equal(captured.commits_complete, false);
  assert.ok(captured.diagnostics.some(d => d.tool_use_id === 'unsupported-global' && d.code === 'unsupported_producer'));
  assert.deepEqual(captured.commits.map(c => c.commit_sha), [retained.sha]);
  assert.deepEqual(captured.commit_references, []);
  const inspection = call('inspection-global', f.cwd);
  const format = '--format=[main %h] %s';
  inspection.content[0].input.cmd = command('log', ['-1', format]);
  const inspected = f.collect([...prior, inspection, result('inspection-global', f.git('-C', f.cwd, ...options, 'log', '-1', format))]);
  assert.equal(inspected.commits_complete, true, 'read-only summary output must not be classified as a producer');
  assert.deepEqual(inspected.commits.map(c => c.commit_sha), [retained.sha]);
  assert.deepEqual(inspected.commit_references, []);
});
