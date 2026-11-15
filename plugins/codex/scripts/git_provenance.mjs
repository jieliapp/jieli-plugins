// Source for the standalone plugin copies; scripts/build-history.mjs distributes it.
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
function commandRepo(input, cwd) {
  const command = input.cmd ?? input.command;
  if (typeof command !== "string") return null;
  // A bounded literal sequence, not a shell parser. Quoted newlines remain arguments.
  if (/[`$\\]/.test(command)) return null;
  const parts = [{tokens: [], piped: false, separator: ""}];
  for (const token of command.match(/"[^"]*"|'[^']*'|&&|\|\||\n|2>&1|>>?|[^\s;&|<>]+|[;&|<>]/g) ?? []) {
    if (token === "&&" || token === "\n" || token === "|") {
      if (token === "|") parts.at(-1).piped = true;
      if (parts.at(-1).tokens.length) parts.push({tokens: [], piped: token === "|", separator: token});
    } else {
      if (/^[;&<]$|^\|\|$/.test(token) || (/["']/.test(token) && !/^"[^"]*"$|^'[^']*'$/.test(token))) return null;
      parts.at(-1).tokens.push(/^["']/.test(token) ? token.slice(1, -1) : token);
    }
  }
  let producing = null;
  for (const {tokens, piped, separator} of parts.filter((part) => part.tokens.length)) {
    // Later output is evidence only when these checks depend on the producer succeeding.
    if (producing && separator !== "&&" && separator !== "|") return null;
    if (tokens[0] !== "git") {
      if (producing && (["rg", "head"].includes(tokens[0]) || (tokens[0] === "go" && tokens[1] === "test"))) continue;
      return null;
    }
    let dir = input.workdir || input.cwd || cwd;
    let i = 1;
    while (tokens[i] === "-C" || tokens[i] === "-c") {
      if (!tokens[i + 1]) return null;
      if (tokens[i] === "-C") dir = resolve(dir, tokens[i + 1]);
      i += 2;
    }
    const action = tokens[i];
    const args = tokens.slice(i + 1);
    if (action === "commit" || action === "cherry-pick") {
      if (producing || piped || args.some((arg) => [">", ">>", "2>&1"].includes(arg))) return null;
      // Recognize normal producing modes explicitly; quiet/status/help variants have no usable summary.
      for (let j = 0; j < args.length; j++) {
        const arg = args[j];
        if (action === "commit" && ["-m", "--message", "-F", "--file", "-am"].includes(arg)) {
          if (!args[++j]) return null;
          continue;
        }
        if (action === "commit" && (/^(?:-m.|-F.|--message=.|--file=.)/.test(arg) ||
          ["--amend", "--no-edit", "--allow-empty", "--allow-empty-message", "-a", "--all", "-s", "--signoff", "-v", "--verbose", "--no-verify"].includes(arg))) continue;
        if (action === "cherry-pick" && ["--continue", "-x"].includes(arg)) continue;
        if (arg.startsWith("-")) return null;
      }
      producing = {dir, amend: action === "commit" && args.includes("--amend")};
    } else if (!["diff", "status", "rev-parse"].includes(action) && !(action === "add" && !producing)) return null;
  }
  return producing;
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
      const running = /Process running with session ID\s+(\d+)/.exec(output);
      if (running) {
        sessions.set(running[1], {
          original:
            sessions.get(String(call.block.input?.process_id))?.original ??
            b.tool_use_id,
          output: (sessions.get(running[1])?.output ?? "") + output,
        });
        continue;
      }
      const prior =
        name(call.block) === "write_stdin"
          ? sessions.get(String(call.block.input?.process_id))
          : null;
      completions.set(prior?.original ?? b.tool_use_id, {
        block: b,
        message: m,
        output: (prior?.output ?? "") + output,
      });
    }
  const repositoryFor = editRepositories();
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
      const directory = dirname(resolve(input.workdir || input.cwd || cwd, path));
      const context = repositoryFor(directory);
      if (context) contexts.set(context.git_root, context);
    }
    tool.git_repositories = [...contexts.values()];
  }
  const failureState = failureStates();
  const previousByRemote = new Map();
  const positions = new Map(messages.map((m, i) => [m.message_id, i]));
  const evidence = [];
  let complete = true;
  for (const m of messages)
    for (const tool of blocks(m)) {
      if (
        tool.type !== "tool_use" ||
        !["Bash", "shell_command", "exec_command"].includes(name(tool))
      )
        continue;
      const call = commandRepo(tool.input ?? {}, cwd);
      if (!call) continue;
      const terminal = completions.get(tool.id);
      if (!terminal || !completed(terminal.block)) continue;
      const fingerprint = createHash("sha256")
        .update(
          JSON.stringify([tool.input, terminal.output, terminal.block.run]),
        )
        .digest("hex");
      const captured = cache.commits[tool.id];
      let record;
      if (captured?.fingerprint === fingerprint && captured.record)
        record = captured.record;
      else {
        const headers = [
          ...terminal.output.matchAll(
            /^\[[^\]\r\n]+\s(?:\(root-commit\)\s)?([a-f0-9]{7,40})\]\s[^\r\n]+/gm,
          ),
        ];
        if (headers.length !== 1) continue;
        const state = failureState(call.dir);
        if (
          captured?.fingerprint === fingerprint &&
          captured.failedState === state
        ) {
          complete = false;
          continue;
        }
        // A failed lookup must not revoke previously captured server evidence.
        cache.commits[tool.id] = { fingerprint, failedState: state };
        const sha = git(call.dir, [
          "rev-parse",
          "--verify",
          `${headers[0][1]}^{commit}`,
        ]);
        if (!sha || !/^[a-f0-9]{40}$/.test(sha)) {
          complete = false;
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
          complete = false;
          continue;
        }
        const [parents, seconds, ...subject] = info.split("\n");
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
          complete = false;
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
        const reflog = call.amend
          ? git(call.dir, ["reflog", "show", "-2", "--format=%H%x09%gs"])
          : null;
        const amendedFrom = reflog
          ?.split("\n")[0]
          ?.startsWith(sha + "\tcommit (amend):")
          ? reflog.split("\n")[1]?.split("\t")[0]
          : "";
        cache.commits[tool.id] = { fingerprint, record, amendedFrom };
      }
      // Ranges depend on the current sequence, so only object validation is cached.
      const prior = previousByRemote.get(record.git_remote_url);
      const inherited =
        call.amend &&
        prior &&
        cache.commits[tool.id]?.amendedFrom === prior.commit_sha;
      const first = prior ? positions.get(prior.end_message_id) + 1 : 0;
      record = {
        ...record,
        commit_message_id: m.message_id,
        end_message_id: terminal.message.message_id,
        start_message_id: inherited
          ? prior.start_message_id
          : messages[first]?.message_id,
        superseded_sha: inherited ? prior.commit_sha : "",
      };
      evidence.push(record);
      previousByRemote.set(record.git_remote_url, record);
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
  };
}
