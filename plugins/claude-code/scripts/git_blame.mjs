import { remoteWithoutCredentials } from "./git_provenance.mjs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  realpathSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";

function git(cwd, args, input) {
  return execFileSync("git", args, {
    cwd,
    input,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  }).trimEnd();
}
function ranges(lines) {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const out = [];
  for (const n of sorted) {
    const last = out.at(-1);
    if (last && last.end + 1 === n) last.end = n;
    else out.push({ start: n, end: n });
  }
  return out;
}

// Git quotes filenames with byte-oriented octal escapes, including UTF-8 names.
function decodeGitPath(raw) {
  const bytes = [];
  for (let i = 1; i < raw.length - 1; i++) {
    if (raw[i] !== "\\") {
      bytes.push(...Buffer.from(raw[i]));
      continue;
    }
    const octal = /^[0-7]{3}/.exec(raw.slice(i + 1));
    if (octal) {
      bytes.push(parseInt(octal[0], 8));
      i += 3;
      continue;
    }
    const escape = raw[++i];
    const special = {
      a: 7,
      b: 8,
      t: 9,
      n: 10,
      v: 11,
      f: 12,
      r: 13,
      "\\": 92,
      '"': 34,
    };
    if (special[escape] === undefined)
      throw new Error("Invalid Git filename escape");
    bytes.push(special[escape]);
  }
  return Buffer.from(bytes).toString("utf8");
}

// Original filename and original coordinates come from Git, never from the requested line's new position.
export function parseBlame(porcelain) {
  const groups = new Map();
  let row = null;
  for (const line of porcelain.split("\n")) {
    const header = /^([a-f0-9]{40}) (\d+) (\d+)(?: \d+)?$/.exec(line);
    if (header) {
      row = {
        sha: header[1],
        original: Number(header[2]),
        current: Number(header[3]),
        path: "",
      };
      continue;
    }
    if (!row) continue;
    if (line.startsWith("filename ")) {
      const raw = line.slice(9);
      row.path = raw.startsWith('"') ? decodeGitPath(raw) : raw;
    }
    if (line.startsWith("\t")) {
      const key = row.sha + "\0" + row.path;
      let item = groups.get(key);
      if (!item) {
        item = { sha: row.sha, path: row.path, original: [], current: [] };
        groups.set(key, item);
      }
      item.original.push(row.original);
      item.current.push(row.current);
      row = null;
    }
  }
  return [...groups.values()].map(({ original, current, ...group }) => ({
    ...group,
    ranges: ranges(original),
    current_ranges: ranges(current),
    uncommitted: /^0+$/.test(group.sha),
  }));
}

export async function runBlame({ opts, baseUrl, apiKey }) {
  if (!opts.commit && !opts.line) {
    console.log(
      "Usage: jieli_helper.mjs blame --commit <sha> | --line <path>:<line>[-<end>] [--cwd <repository>]",
    );
    return 2;
  }
  const cwd = realpathSync(resolve(opts.cwd || process.cwd()));
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  const remote = remoteWithoutCredentials(
    git(root, ["config", "--get", "remote.origin.url"]),
  );
  let groups;
  if (opts.line) {
    const match = /^(.+):(\d+)(?:-(\d+))?$/.exec(opts.line);
    if (!match) throw new Error("Expected --line path:start[-end]");
    const start = Number(match[2]),
      end = Number(match[3] || match[2]);
    if (start < 1 || end < start || end - start >= 1000)
      throw new Error("Choose 1–1000 valid lines");
    const path = relative(root, resolve(cwd, match[1]));
    if (path === ".." || path.startsWith("../"))
      throw new Error("The path must be inside this repository");
    groups = parseBlame(
      git(root, [
        "-c",
        "core.quotePath=false",
        "blame",
        "--line-porcelain",
        "-L",
        `${start},${end}`,
        "--",
        path,
      ]),
    );
  } else {
    if (!/^[a-f0-9]{4,40}$/i.test(opts.commit))
      throw new Error("Expected a commit SHA");
    groups = [
      {
        sha: git(root, ["rev-parse", "--verify", `${opts.commit}^{commit}`]),
        ranges: [],
      },
    ];
  }
  const cacheDir = join(homedir(), ".jieli", "blame-patches");
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const lookup = async (group, patchID = "") => {
    const url = new URL("/plugin/provenance/commit", baseUrl);
    url.searchParams.set("repo", remote);
    url.searchParams.set("sha", group.sha);
    if (patchID) url.searchParams.set("patch_id", patchID);
    if (group.path) {
      url.searchParams.set("path", group.path);
      url.searchParams.set(
        "ranges",
        group.ranges.map((r) => `${r.start}-${r.end}`).join(","),
      );
    }
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(20000),
    });
    const body = await response.json();
    if (!response.ok || !body.success)
      throw new Error(body.message || `HTTP ${response.status}`);
    return body.data;
  };
  const output = [];
  for (const group of groups) {
    if (group.uncommitted) {
      output.push({ ...group, reason: "uncommitted_lines" });
      continue;
    }
    let provenance = await lookup(group);
    if (
      provenance.execution.status === "none" &&
      provenance.sources.status === "none"
    ) {
      const key = createHash("sha256")
        .update(root + "\0" + group.sha)
        .digest("hex");
      const file = join(cacheDir, key + ".json");
      let patchID;
      if (existsSync(file))
        patchID = JSON.parse(readFileSync(file, "utf8")).patch_id;
      else {
        const parents = git(root, ["show", "-s", "--format=%P", group.sha])
          .trim()
          .split(" ")
          .filter(Boolean);
        patchID =
          parents.length > 1
            ? ""
            : git(
                root,
                ["patch-id", "--stable"],
                git(root, [
                  "show",
                  "--format=",
                  "--no-ext-diff",
                  "--no-textconv",
                  group.sha,
                ]) + "\n",
              ).split(/\s+/)[0];
        writeFileSync(file, JSON.stringify({ patch_id: patchID }), {
          mode: 0o600,
        });
      }
      if (patchID) provenance = await lookup(group, patchID);
    }
    output.push({ ...group, ...provenance });
  }
  console.log(JSON.stringify({ repo: remote, results: output }, null, 2));
  return 0;
}
