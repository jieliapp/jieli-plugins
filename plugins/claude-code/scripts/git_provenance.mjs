// Source for the standalone plugin copies; scripts/build-history.mjs distributes it.
import { commitCommands, shellActivity } from "./shell_commands.mjs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  realpathSync,
  statSync,
  readdirSync,
} from "node:fs";
import {
  join,
  resolve,
  dirname,
  relative,
  delimiter,
} from "node:path";

function git(cwd, args, input) {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    input,
    timeout: 5000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (r.error || r.status !== 0) return null;
  return r.stdout.trimEnd();
}
export function remoteWithoutCredentials(raw) {
  if (!raw) return "";
  if (!raw.includes("://")) return raw;
  const u = new URL(raw);
  u.password = "";
  if (u.protocol === "https:") u.username = "";
  u.search = "";
  u.hash = "";
  return u.toString();
}
function blocks(message) {
  return Array.isArray(message.content) ? message.content : [];
}
function name(tool) {
  return String(tool.name).split(".").at(-1);
}
function completed(block) {
  return (
    block.run?.status === "completed" &&
    (block.run.result?.exitCode == null || block.run.result.exitCode === 0)
  );
}

// Resolve the nearest Git boundary, including nested repositories and linked worktrees.
// Cache directory walks so a long transcript reads metadata once per repository root.
function editRepositories() {
  const directories = new Map();
  return (directory) => {
    const visited = [];
    let context = null;
    for (let dir = resolve(directory); ; dir = dirname(dir)) {
      if (directories.has(dir)) {
        context = directories.get(dir);
        break;
      }
      visited.push(dir);
      if (existsSync(join(dir, ".git"))) {
        const root = git(dir, ["rev-parse", "--show-toplevel"]);
        const remote = git(dir, ["config", "--get", "remote.origin.url"]);
        if (root) context = {
          git_root: resolve(dir, relative(realpathSync(dir), root)),
          git_remote_url: remoteWithoutCredentials(remote ?? ""),
        };
        break;
      }
      if (dirname(dir) === dir) break;
    }
    for (const dir of visited) directories.set(dir, context);
    return context;
  };
}

// Sample repository metadata and object directories once, never every object or source file.
function failureStates() {
  const states = new Map();
  return (cwd) => {
    if (states.has(cwd)) return states.get(cwd);
    const paths = git(cwd, [
      "rev-parse",
      "--path-format=absolute",
      "--git-dir",
      "--git-common-dir",
      "--git-path",
      "objects",
    ]);
    if (paths === null) {
      states.set(cwd, "unavailable");
      return "unavailable";
    }
    const [gitDir, commonDir, objects] = paths.split("\n");
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    const files = [
      gitDir,
      commonDir,
      join(gitDir, "HEAD"),
      join(gitDir, "logs", "HEAD"),
      join(commonDir, "config"),
      join(commonDir, "packed-refs"),
      join(commonDir, "FETCH_HEAD"),
      join(commonDir, "shallow"),
    ];
    if (head.startsWith("ref: ")) files.push(join(commonDir, head.slice(5)));
    const objectDirs = [
      objects,
      ...(process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES?.split(delimiter).filter(
        Boolean,
      ) ?? []),
    ];
    const visited = new Set();
    for (const directory of objectDirs) {
      files.push(directory);
      if (!statSync(directory, { throwIfNoEntry: false })) continue;
      const canonical = realpathSync(directory);
      if (visited.has(canonical)) continue;
      visited.add(canonical);
      const alternates = join(canonical, "info", "alternates");
      files.push(canonical, join(canonical, "pack"), alternates);
      // Any missing tree/blob may belong to another bucket. There are at most 256 buckets per store.
      for (const bucket of readdirSync(canonical).filter((name) =>
        /^[a-f0-9]{2}$/.test(name),
      )) {
        files.push(join(canonical, bucket));
      }
      if (existsSync(alternates)) {
        for (const path of readFileSync(alternates, "utf8")
          .split("\n")
          .filter(Boolean)) {
          objectDirs.push(resolve(canonical, path));
        }
      }
    }
    const state = createHash("sha256")
      .update(
        JSON.stringify(
          files.map((path) => {
            const stat = statSync(path, {
              bigint: true,
              throwIfNoEntry: false,
            });
            return [
              path,
              stat
                ? `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
                : null,
            ];
          }),
        ),
      )
      .digest("hex");
    states.set(cwd, state);
    return state;
  };
}

export function collectGitEvidence({
  provider,
  sessionId,
  cwd,
  messages,
  cacheDir,
}) {
  const file = join(
    cacheDir,
    `${provider}-${createHash("sha256").update(sessionId).digest("hex")}.json`,
  );
  const cache = existsSync(file)
    ? JSON.parse(readFileSync(file, "utf8"))
    : { commits: {}, git_remote_url: "", git_root: "" };
  const remote = git(cwd, ["config", "--get", "remote.origin.url"]);
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (remote) cache.git_remote_url = remoteWithoutCredentials(remote);
  if (root) {
    cache.git_root = resolve(cwd, relative(realpathSync(cwd), root));
  }
  const calls = new Map();
  const completions = new Map();
  const sessions = new Map();
  for (const m of messages)
    for (const b of blocks(m)) {
      if (b.type === "tool_use") calls.set(b.id, { message: m, block: b });
      if (b.type !== "tool_result") continue;
      const call = calls.get(b.tool_use_id);
      if (!call) continue;
      const output = b.run?.result?.output ?? "";
      const priorSession = name(call.block) === "write_stdin"
        ? sessions.get(String(call.block.input?.process_id ?? call.block.input?.session_id)) : null;
      const running = /Process running with session ID\s+(\d+)/.exec(output);
      if (running) {
        sessions.set(running[1], {
          original:
            priorSession?.original ??
            b.tool_use_id,
          output: (priorSession?.output ?? "") + output,
        });
        continue;
      }
      const prior =
        name(call.block) === "write_stdin"
          ? priorSession
          : null;
      if (prior) sessions.delete(String(call.block.input?.process_id ?? call.block.input?.session_id));
      completions.set(prior?.original ?? b.tool_use_id, {
        block: b,
        message: m,
        output: (prior?.output ?? "") + output,
      });
    }
  const diagnostics = [];
  let complete = true;
  const diagnose = (tool, code) => {
    complete = false;
    if (diagnostics.some(d => d.tool_use_id === tool?.id && d.code === code)) return;
    const diagnostic = { tool_use_id: tool?.id ?? "", code };
    if (diagnostics.length < 100) diagnostics.push(diagnostic);
    else if (diagnostics.at(-1).code !== "diagnostics_truncated") diagnostics[99] = { ...diagnostic, code: "diagnostics_truncated" };
  };
  const repositoryFor = editRepositories();
  const positions = new Map(messages.map((m, i) => [m.message_id, i]));
  const repositoryActivity = new Map();
  const addRepository = (context, tool, message) => {
    if (!context) return;
    const entry = { ...context };
    if (tool) entry.tool_use_id = tool.id;
    if (message) {
      entry.message_id = message.message_id;
      if (Number.isFinite(message.timestamp_ms)) entry.event_ms = message.timestamp_ms;
    }
    let activity = repositoryActivity.get(entry.git_root);
    if (!activity) {
      activity = {};
      repositoryActivity.set(entry.git_root, activity);
    }
    if (!tool) activity.initial = entry;
    else {
      const position = positions.get(message.message_id);
      if (!activity.first || position < positions.get(activity.first.message_id)) activity.first = entry;
      if (!activity.last || position >= positions.get(activity.last.message_id)) activity.last = entry;
    }
  };
  if (cache.git_root) addRepository({ git_root: cache.git_root, git_remote_url: cache.git_remote_url });
  for (const { block: tool } of calls.values()) {
    const input = tool.input ?? {};
    let paths;
    switch (name(tool)) {
      case "Edit": case "edit_file": case "Write": case "write_file":
      case "create_file": case "MultiEdit":
        paths = [input.file_path ?? input.path];
        break;
      case "apply_patch":
        paths = [...String(input.patch_text ?? "").matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File: |Move to: )(.+)$/gm)].map((m) => m[1]);
        break;
      default: continue;
    }
    const terminal = completions.get(tool.id);
    if (!terminal || !completed(terminal.block)) continue;
    const contexts = new Map();
    for (const path of paths) {
      if (typeof path !== "string" || !path) continue;
      const directory = dirname(resolve(cwd, input.workdir || input.cwd || ".", path));
      const context = repositoryFor(directory);
      if (context) contexts.set(context.git_root, context);
    }
    tool.git_repositories = [...contexts.values()];
    for (const context of contexts.values()) addRepository(context, tool, calls.get(tool.id).message);
  }
  const failureState = failureStates();
  const previousByRemote = new Map();
  const evidence = [];
  const references = [];

  for (const m of messages)
    for (const tool of blocks(m)) {
      if (
        tool.type !== "tool_use" ||
        !["Bash", "shell_command", "exec_command"].includes(name(tool))
      )
        continue;
      let commands = commitCommands(tool.input ?? {}, cwd);
      const activity = shellActivity(tool.input ?? {}, cwd);
      const terminal = completions.get(tool.id);
      if (!terminal || !completed(terminal.block)) {
        if (activity.producer) diagnose(tool, !terminal || terminal.block.run?.status !== "completed" ? "producer_not_completed" : "producer_not_successful");
        continue;
      }
      for (const dir of activity.dirs) addRepository(repositoryFor(dir), tool, m);
      let reference = false;
      if (!commands?.length) {
        if (!activity.producer) continue;
        diagnose(tool, "unsupported_producer");
        const targets = new Map();
        for (const dir of activity.targetDirs) {
          const context = repositoryFor(dir);
          if (!context) { targets.set(dir, null); continue; }
          targets.set(context.git_root, context);
        }
        if (!activity.referenceEligible || targets.size !== 1 || ![...targets.values()][0]?.git_remote_url) continue;
        reference = true;
        commands = [{ dir: [...targets.values()][0].git_root, amend: false }];
      }
      const fingerprint = createHash("sha256")
        .update(
          JSON.stringify([tool.input, terminal.output, terminal.block.run]),
        )
        .digest("hex");
      const headers = [...terminal.output.matchAll(
        /^\[[^\]\r\n]+\s(?:\(root-commit\)\s)?([a-f0-9]{7,40})\]\s[^\r\n]+/gm,
      )];
      const prefixes = headers.map(h => h[1]).sort();
      if (!headers.length || (!reference && headers.length !== commands.length) || prefixes.some((prefix, i) => i > 0 && prefix.startsWith(prefixes[i - 1]))) {
        diagnose(tool, "ambiguous_commit_summary");
        continue;
      }
      if (reference) commands = headers.map(() => commands[0]);
      for (const [index, call] of commands.entries()) {
        if (reference && references.length >= 500) {
          diagnose(tool, "commit_references_truncated");
          break;
        }
        // Keep the original key for single-command evidence already cached.
        const cacheKey = (reference ? "reference:" : "") + (index === 0 ? tool.id : `${tool.id}:${index}`);
        const captured = cache.commits[cacheKey];
        let record;
        if (captured?.fingerprint === fingerprint && captured.record)
          record = captured.record;
        else {
          const state = failureState(call.dir);
          if (
            captured?.fingerprint === fingerprint &&
            captured.failedState === state
          ) {
            diagnose(tool, "object_lookup_failed");
            continue;
          }
          // A failed lookup must not revoke previously captured server evidence.
          cache.commits[cacheKey] = { fingerprint, failedState: state };
          const sha = git(call.dir, [
            "rev-parse",
            "--verify",
            `${headers[index][1]}^{commit}`,
          ]);
          if (!sha || !/^[a-f0-9]{40}$/.test(sha)) {
            diagnose(tool, "object_lookup_failed");
            continue;
          }
          const info = git(call.dir, ["show", "-s", "--format=%P%n%ct%n%s", sha]);
          const files = git(call.dir, [
            "diff-tree",
            "--root",
            "--no-commit-id",
            "--name-only",
            "-r",
            sha,
          ]);
          const rawRemote = git(call.dir, [
            "config",
            "--get",
            "remote.origin.url",
          ]);
          if (info === null || files === null || rawRemote === null) {
            diagnose(tool, "object_lookup_failed");
            continue;
          }
          const [parents, seconds, ...subject] = info.split("\n");
          if (reference && headers[index][0].slice(headers[index][0].indexOf("] ") + 2) !== subject.join("\n")) {
            diagnose(tool, "summary_subject_mismatch");
            continue;
          }
          const diff =
            parents.split(" ").filter(Boolean).length > 1
              ? ""
              : git(call.dir, [
                  "show",
                  "--format=",
                  "--no-ext-diff",
                  "--no-textconv",
                  sha,
                ]);
          const patch = diff
            ? git(call.dir, ["patch-id", "--stable"], diff + "\n")
            : "";
          if (diff === null || patch === null) {
            diagnose(tool, "object_lookup_failed");
            continue;
          }
          record = {
            commit_sha: sha,
            patch_id: patch.split(/\s+/)[0],
            subject: subject.join("\n"),
            files: files ? files.split("\n").slice(0, 500) : [],
            files_truncated: files.split("\n").length > 500,
            git_remote_url: remoteWithoutCredentials(rawRemote),
            commit_tool_use_id: tool.id,
            committed_at_ms: Number(seconds) * 1000,
          };
          // Later producers in this tool can move HEAD past an amend before capture.
          const reflog = call.amend
            ? git(call.dir, ["reflog", "show", `-${commands.length - index + 1}`, "--format=%H%x09%gs"])?.split("\n")
            : [];
          const amendedIndex = reflog?.findIndex(entry => entry.startsWith(sha + "\tcommit (amend):")) ?? -1;
          const amendedFrom = amendedIndex >= 0 ? reflog[amendedIndex + 1]?.split("\t")[0] : "";
          cache.commits[cacheKey] = { fingerprint, record, amendedFrom };
        }
        // Ranges depend on the current sequence, so only object validation is cached.
        const prior = previousByRemote.get(record.git_remote_url);
        const inherited =
          call.amend &&
          prior &&
          cache.commits[cacheKey]?.amendedFrom === prior.commit_sha;
        const sameTool = prior?.end_message_id === terminal.message.message_id;
        const first = prior ? positions.get(prior.end_message_id) + 1 : 0;
        record = {
          ...record,
          commit_message_id: m.message_id,
          end_message_id: terminal.message.message_id,
          start_message_id: inherited || sameTool
            ? prior.start_message_id
            : messages[first]?.message_id,
          superseded_sha: inherited ? prior.commit_sha : "",
        };
        (reference ? references : evidence).push(record);
        addRepository(repositoryFor(call.dir), tool, m);
        if (!reference) previousByRemote.set(record.git_remote_url, record);
      }
    }
  // Prioritize initial workspace + every distinct repository before spending
  // remaining slots on first/last anchors from repeated operations.
  const repositories = [];
  const repositoryKeys = new Set();
  const emitRepository = entry => {
    if (!entry) return;
    const key = JSON.stringify([entry.git_root, entry.tool_use_id]);
    if (repositoryKeys.has(key)) return;
    if (repositories.length >= 256) {
      diagnose({ id: entry.tool_use_id }, "repositories_truncated");
      return;
    }
    repositoryKeys.add(key);
    repositories.push(entry);
  };
  for (const activity of repositoryActivity.values()) emitRepository(activity.initial ?? activity.first);
  for (const activity of repositoryActivity.values()) {
    emitRepository(activity.first);
    emitRepository(activity.last);
  }
  const encoded = JSON.stringify(cache);
  if (!existsSync(file) || readFileSync(file, "utf8") !== encoded) {
    mkdirSync(dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, encoded, { mode: 0o600 });
    renameSync(temp, file);
  }
  return {
    git_remote_url: cache.git_remote_url,
    git_root: cache.git_root,
    provenance_version: 1,
    commits_complete: complete,
    commits: evidence,
    repositories,
    commit_references: references,
    diagnostics,
  };
}
