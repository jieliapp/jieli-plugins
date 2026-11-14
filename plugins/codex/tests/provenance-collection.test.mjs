import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  readFileSync,
  renameSync,
  mkdirSync,
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

for (const scenario of [
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
    name: "two successful commits followed by reading HEAD",
    stage: true,
    command: () => 'git commit -m second && git commit --allow-empty -m third && git rev-parse HEAD',
  },
]) test(`rejects ${scenario.name}`, (t) => {
  const f = fixture(t);
  const first = f.commit("first");
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
