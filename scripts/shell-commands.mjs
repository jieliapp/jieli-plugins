import { parse, forEachChild } from "unbash";
import { basename, resolve } from "node:path";

// Only literal words are usable as repository/command evidence. Parsing an
// expansion does not tell us what it evaluated to in the original process.
function literal(word, variables = {}) {
  if (word?.type !== "Word") return null;
  let valid = true;
  const visit = (node) => {
    if (!["Word", "Literal", "SingleQuoted", "DoubleQuoted"].includes(node.type)) valid = false;
    forEachChild(node, visit);
  };
  visit(word);
  if (valid && !word.text.startsWith("~")) return word.value;
  // A literal for-list has a known binding; only its exact quoted reference is
  // accepted, and only in the read-only loop handled below.
  for (const [key, value] of Object.entries(variables)) {
    if (word.text === `"$${key}"` || word.text === `"\${${key}}"`) return value;
  }
  return null;
}

function script(source) {
  if (typeof source !== "string" || source.length > 256 * 1024) return null;
  try {
    const ast = parse(source);
    return ast.errors?.length ? null : ast;
  } catch { return null; }
}

// Keep option boundaries identical for collection and trailer insertion: a
// message/file/trailer value named "--" is not the pathspec separator.
function commitOptions(args) {
  let amend = false, hasTrailer = false, pathspec = -1, stdin = false;
  const jieliTrailer = /(?:^|\r?\n)[\t ]*Jieli-Thread[\t ]*[:=]/i;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") { pathspec = i; break; }
    if (["-m", "--message", "-F", "--file", "-am", "--trailer"].includes(arg)) {
      if (args[i + 1] === undefined) return null;
      const value = args[++i];
      if (["-F", "--file"].includes(arg)) stdin = value === "-";
      if (["-m", "--message", "-am", "--trailer"].includes(arg) && jieliTrailer.test(value)) hasTrailer = true;
      continue;
    }
    if (arg.startsWith("--trailer=")) {
      if (jieliTrailer.test(arg.slice(10))) hasTrailer = true;
      continue;
    }
    const message = /^(?:-m|--message=)([\s\S]+)$/.exec(arg);
    if (message) {
      if (jieliTrailer.test(message[1])) hasTrailer = true;
      continue;
    }
    const file = /^(?:-F|--file=)([\s\S]+)$/.exec(arg);
    if (file) { stdin = file[1] === "-"; continue; }
    if (["--amend", "--no-edit", "--allow-empty", "--allow-empty-message", "-a", "--all", "-s", "--signoff", "-v", "--verbose", "--no-verify"].includes(arg)) {
      if (arg === "--amend") amend = true;
      continue;
    }
    if (arg.startsWith("-")) return null;
  }
  return { amend, hasTrailer, pathspec, stdin };
}

// Edit source spans, not printed AST text, so comments/quoting/heredocs stay exact.
export function injectTrailer(source, trailer) {
  const ast = script(source);
  if (!ast) return "";
  const insertions = [];
  let loopsAllowed;
  const visit = node => {
    if (node.type === "Statement") return !node.background && visit(node.command);
    if (node.type === "AndOr") return node.operators.every(op => op === "&&") && node.commands.every(visit);
    // Reuse the collector's bounded read-only-loop proof. Parse at most once
    // more for the whole script; never rewrite dynamic commands inside loops.
    if (node.type === "For") return loopsAllowed ??= Boolean(commitCommands({ cmd: source }, ".")?.length);
    if (node.type !== "Command") return false;
    if (literal(node.name) !== "git") return true;
    if (node.prefix.length) return false;
    const words = node.suffix.filter(part => part.type === "Word");
    const args = words.map(word => literal(word));
    if (args.some(arg => arg === null)) return false;
    let i = 0;
    while (args[i] === "-C" || args[i] === "-c") {
      if (!args[i + 1]) return false;
      i += 2;
    }
    if (args[i] !== "commit") return true;
    const options = commitOptions(args.slice(i + 1));
    if (!options) return false;
    if (options.hasTrailer) return true;
    const separator = options.pathspec >= 0 ? words[i + 1 + options.pathspec] : null;
    // Inserting after the last argument also handles interleaved redirections;
    // no option is ever inserted between -m/-F and its value.
    insertions.push(separator ? { pos: separator.pos, before: true } : { pos: words.at(-1).end, before: false });
    return true;
  };
  if (!ast.commands.every(visit) || !insertions.length) return "";
  const quoted = `"${String(trailer).replace(/["\\$`]/g, "\\$&")}"`;
  let output = source;
  for (const { pos, before } of insertions.sort((a, b) => b.pos - a.pos)) {
    output = output.slice(0, pos) + (before ? `--trailer ${quoted} ` : ` --trailer ${quoted}`) + output.slice(pos);
  }
  return output;
}

// Accept deterministic success chains, not an interpreter for arbitrary shell.
// The caller still requires completed output and verifies each Git object.
export function commitCommands(input, cwd, { reference = false } = {}) {
  const source = input.cmd ?? input.command;
  const ast = script(source);
  if (!ast) return null;
  const commands = [];
  let errexit = false;
  let currentDir = resolve(cwd, input.workdir || input.cwd || ".");
  let loopSeen = false;
  let preparationSeen = false, endsInProducer = false;
  let followUpSeen = false;
  const visit = (node, { piped = false, readOnly = false, variables = {}, topLevel = false, directorySafe = false } = {}) => {
    if (node.type === "Statement") {
      if (node.background) return false; // Background statements are not completion evidence.
      return visit(node.command, { piped, readOnly, variables, topLevel, directorySafe });
    }
    if (node.type === "AndOr") {
      return node.operators.every(op => op === "&&") &&
        node.commands.every(child => visit(child, { piped, readOnly, variables, directorySafe }));
    }
    if (node.type === "Pipeline") {
      return !reference && !node.prefixes.length && node.operators.every(op => op === "|") &&
        node.commands.every(child => visit(child, { piped: true, readOnly, variables }));
    }
    if (node.type === "For") {
      if (reference || readOnly || !errexit || !commands.length || !node.wordlist?.length || node.wordlist.length > 64) return false;
      const key = literal(node.name);
      const values = node.wordlist.map(word => literal(word));
      if (!key || values.some(value => value === null)) return false;
      loopSeen = true;
      return values.every(value => node.body.commands.every(child => visit(child, { readOnly: true, variables: { [key]: value } })));
    }
    if (node.type !== "Command" || node.prefix.length) return false;
    endsInProducer = false;
    const executable = literal(node.name);
    const words = node.suffix.filter(part => part.type === "Word");
    const redirects = node.suffix.filter(part => part.type !== "Word");
    if (reference && redirects.length) return false;
    const literalStdin = redirects.length === 1 && redirects[0].type === "HereDoc" &&
      ["<<", "<<-"].includes(redirects[0].operator) && redirects[0].delimiter?.quoted &&
      Boolean(redirects[0].closing) && (!redirects[0].descriptor ||
        (redirects[0].descriptor.type === "FileDescriptor" && redirects[0].descriptor.value === 0));
    if (!literalStdin && redirects.some(part => part.type !== "Redirect" || ![">", ">>", ">&"].includes(part.operator) || literal(part.target, variables) === null)) return false;
    const args = words.map(word => literal(word, variables));
    if (args.some(value => value === null)) return false;
    if (executable === "set") {
      if (!topLevel || readOnly || piped || redirects.length || commands.length || args.join(" ") !== "-e") return false;
      errexit = true;
      return true;
    }
    if (executable === "cd") {
      if (!directorySafe || readOnly || piped || redirects.length || args.length !== 1 || args[0].startsWith("-")) return false;
      currentDir = resolve(currentDir, args[0]);
      return true;
    }
    if (executable !== "git") {
      if (reference) return false;
      if (["python", "python3"].includes(executable)) {
        if (!topLevel || readOnly || piped || commands.length || args.length !== 1 || args[0] !== "-" || !literalStdin) return false;
        preparationSeen = true;
        return true;
      }
      return !literalStdin && !readOnly && commands.length > 0 &&
        (["rg", "head"].includes(executable) || (executable === "go" && args[0] === "test"));
    }
    let dir = currentDir;
    let i = 0;
    while (args[i] === "-C" || args[i] === "-c") {
      if (!args[i + 1]) return false;
      if (reference && args[i] === "-c") return false;
      if (args[i] === "-C") dir = resolve(dir, args[i + 1]);
      i += 2;
    }
    const action = args[i++];
    const options = args.slice(i);
    if (action === "merge-base" && options.length === 3 && options[0] === "--is-ancestor" && options.slice(1).every(arg => arg && !arg.startsWith("-"))) {
      if (commands.length) followUpSeen = true;
      return !piped && !redirects.length;
    }
    if (commands.length && !readOnly && (action === "push" || action === "ls-remote")) {
      const flags = action === "push"
        ? ["-u", "--set-upstream", "--force-with-lease", "--porcelain", "-q", "--quiet", "-v", "--verbose"]
        : ["--exit-code", "--heads", "--branches", "--tags", "--refs"];
      followUpSeen = true;
      return !piped && !redirects.length && options.every(arg => arg && (!arg.startsWith("-") || flags.includes(arg)));
    }
    if (action !== "commit" && action !== "cherry-pick") {
      if (reference) {
        if (action === "diff") return options.length > 0 && options.every(arg => ["--cached", "--check", "--name-status", "--stat", "--no-ext-diff", "--no-textconv"].includes(arg));
        if (action === "status") return options.every(arg => ["--short", "--branch", "--porcelain", "-sb"].includes(arg));
        return action === "add";
      }
      return !literalStdin && (["diff", "status", "rev-parse", "log"].includes(action) || (!readOnly && action === "add"));
    }
    if (reference && (action !== "commit" || commands.length)) return false;
    if (readOnly || piped || loopSeen) return false;
    const mode = action === "commit" ? commitOptions(options) : { amend: false };
    if (!mode) return false;
    if (redirects.length && !(literalStdin && mode.stdin)) return false;
    if (action === "cherry-pick" && options.some(option => option.startsWith("-") && !["--continue", "-x"].includes(option))) return false;
    commands.push({ dir, amend: !reference && mode.amend });
    endsInProducer = true;
    return true;
  };
  for (const [index, statement] of ast.commands.entries()) {
    // Without errexit, a later top-level command can mask a failed producer.
    if (!reference && commands.length && !errexit) return null;
    const before = commands.length;
    if (!visit(statement, { topLevel: true, directorySafe: index === ast.commands.length - 1 || (errexit && statement.command.type !== "AndOr") })) return null;
    // errexit does not abort a nonfinal && list when an earlier operand fails.
    // Only the final list has its success established by the tool exit status.
    if (!reference && commands.length > before && statement.command.type === "AndOr" && index !== ast.commands.length - 1) return null;
  }
  if (reference && !followUpSeen) return null;
  // Python is opaque preparation. Require the final shell status to belong to
  // a producer (or its && chain), never a following status/inspection command.
  return preparationSeen && !endsInProducer ? null : commands;
}

// A separate, weaker observation path. This never upgrades opaque programs to
// execution evidence; only the strict parser above may do that. All syntax and
// control-flow decisions come from unbash, including heredoc boundaries.
export function shellActivity(input, cwd) {
  const ast = script(input.cmd ?? input.command);
  if (!ast) return { dirs: [], targetDirs: [], producer: true, referenceEligible: false };
  let producer = false;
  const scan = node => {
    if (node.type === 'Command') {
      const executable = literal(node.name);
      const args = node.suffix.filter(p => p.type === 'Word').map(p => literal(p));
      if (executable && /^(?:.*\/)?python(?:\d+(?:\.\d+)*)?$/.test(executable)) producer = true;
      if (executable && basename(executable) === 'git') {
        let i = 0;
        // Detection only: standard global options locate the subcommand but
        // do not prove its repository or execution. Keep the strict parser and
        // reference eligibility unchanged for these unsupported invocations.
        while (i < args.length) {
          const arg = args[i];
          if (arg === null) break;
          if (['-p', '--paginate', '-P', '--no-pager', '--no-replace-objects', '--no-lazy-fetch', '--no-optional-locks', '--no-advice', '--bare', '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs'].includes(arg)) {
            i++;
          } else if (['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix', '--attr-source'].includes(arg)) {
            if (args[i + 1] === undefined) break;
            i += 2;
          } else if (arg.includes('=') && ['--git-dir', '--work-tree', '--namespace', '--config-env', '--exec-path', '--super-prefix', '--attr-source'].includes(arg.split('=', 1)[0])) {
            i++;
          } else break; // Stop at the action, including read-only/help actions.
        }
        if (['commit', 'cherry-pick'].includes(args[i])) producer = true;
      }
    }
    forEachChild(node, scan);
  };
  scan(ast);
  let dir = resolve(cwd, input.workdir || input.cwd || ".");
  let errexit = false, eligible = true;
  const dirs = [], targetDirs = [];
  const visit = (node, directorySafe, topLevel = false) => {
    if (node.type === 'Statement') return !node.background && visit(node.command, directorySafe, topLevel);
    if (node.type === 'AndOr') return node.operators.every(op => op === '&&') && node.commands.every(child => visit(child, directorySafe));
    if (node.type !== 'Command' || node.prefix.length) return false;
    const executable = literal(node.name);
    const args = node.suffix.filter(p => p.type === 'Word').map(p => literal(p));
    if (!executable || args.some(a => a === null)) return false;
    const python = /^(?:.*\/)?python(?:\d+(?:\.\d+)*)?$/.test(executable);
    // Only commands known not to mutate the parent shell's execution state.
    // In particular exit/exec/eval/source/export/trap/pushd are not neutral.
    if (!python && !['git', 'cd', 'set', 'true', 'false', 'echo', 'printf', 'cat', 'rg', 'head', 'tail', 'sed', 'ls', 'pwd', 'go', 'npm', 'node', 'wc', 'find', 'sleep', 'touch', 'mkdir'].includes(executable)) return false;
    if (executable === 'set') {
      if (!topLevel || dirs.length || args.join(' ') !== '-e' || node.suffix.some(p => p.type !== 'Word')) return false;
      errexit = true;
      return true;
    }
    if (executable === 'cd') {
      if (!directorySafe || args.length !== 1 || args[0].startsWith('-') || node.suffix.some(p => p.type !== 'Word')) return false;
      dir = resolve(dir, args[0]);
      dirs.push(dir);
      return true;
    }
    if (executable === 'git') {
      let target = dir, i = 0;
      while (['-C', '-c'].includes(args[i])) {
        if (!args[i + 1]) return false;
        if (args[i] === '-C') target = resolve(target, args[i + 1]);
        // Environment/config overrides can change both repository and output.
        if (args[i] === '-c') eligible = false;
        i += 2;
      }
      const action = args[i], options = args.slice(i + 1);
      if (!['add', 'commit', 'cherry-pick', 'push', 'diff', 'status', 'remote'].includes(action)) eligible = false;
      if (action === 'commit' && (!commitOptions(options) || node.suffix.some(p => p.type !== 'Word'))) eligible = false;
      if (action === 'cherry-pick' && options.some(a => a.startsWith('-') && !['--continue', '-x'].includes(a))) eligible = false;
      targetDirs.push(target);
      if (directorySafe) dirs.push(target);
    } else {
      if (directorySafe) dirs.push(dir);
      if (python) {
        targetDirs.push(dir);
        if (node.suffix.some(p => p.type !== 'Word' && !(p.type === 'HereDoc' && p.delimiter?.quoted && p.closing && (!p.descriptor || (p.descriptor.type === 'FileDescriptor' && p.descriptor.value === 0))))) eligible = false;
      }
      else if (executable !== 'cat' || !node.suffix.some(p => p.type === 'Redirect' && ['>', '>>'].includes(p.operator))) eligible = false;
    }
    return true;
  };
  for (const [index, statement] of ast.commands.entries()) {
    if (!visit(statement, index === ast.commands.length - 1 || (errexit && statement.command.type !== 'AndOr'), index === 0)) {
      return { dirs: [], targetDirs: [], producer, referenceEligible: false };
    }
  }
  return { dirs, targetDirs, producer, referenceEligible: producer && eligible };
}
