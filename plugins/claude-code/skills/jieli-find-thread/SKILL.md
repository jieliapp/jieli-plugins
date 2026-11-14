---
name: jieli-find-thread
description: "Search prior Jieli threads by keywords, repo, file, topic, or other clues, then optionally read a matching thread."
---

# Jieli Find

## Environment

Resolve `../../scripts/jieli_helper.mjs` relative to this `SKILL.md` file and run it directly for thread search:

```bash
node <resolved-skill-dir>/../../scripts/jieli_helper.mjs find-threads ...
```

Do not depend on plugin `bin/` commands being on `PATH`; agent app shells may not include the plugin `bin/` directory. Do not duplicate raw `curl` calls unless you are diagnosing the helper, and do not enumerate installed helpers or choose wrapper files in this skill.

If the API key is missing, ask the user to configure the plugin, export `JIELI_API_KEY`, or write `~/.config/jieli/settings.json`. Jieli uses `https://jieli.app` by default.

## Search Procedure

1. Build the shortest useful search query from the user's clue. Keep file paths, repo names, branch names, error text, or topic words intact.
2. Search all providers by default:

```bash
node <resolved-skill-dir>/../../scripts/jieli_helper.mjs find-threads "<query>" --page-size 10 --sort updated
```

3. Do not infer `--provider` from the current agent. Pass it only when the user explicitly asks for one:

```bash
node <resolved-skill-dir>/../../scripts/jieli_helper.mjs find-threads "<query>" --provider codex --page-size 10 --sort updated
node <resolved-skill-dir>/../../scripts/jieli_helper.mjs find-threads "<query>" --provider claude_code --page-size 10 --sort updated
```

4. Add optional filters only when explicit or strongly implied:

```bash
node <resolved-skill-dir>/../../scripts/jieli_helper.mjs find-threads "<query>" --repo "<repo>" --label "<label>" --page-size 10 --page 2 --sort updated
```

5. Return a compact ranked list using the helper's `thread_id`/`provider_thread_id` and `read_url`.
6. If one result clearly answers the request, read that thread before answering. Otherwise ask which result to inspect.
7. If the helper fails, report the non-secret error message.

## Output

For search-only requests, return a concise ranked list. For content requests, read the selected result and summarize the match, key goals/decisions, relevant files/commands/verification, and open follow-ups. Redact secrets.

## Git provenance and Agent Blame

When the question concerns why code exists or which conversation produced a commit, query the local repository directly:

```bash
node <resolved-skill-dir>/../../scripts/jieli_helper.mjs blame --commit <sha> --cwd <repository>
node <resolved-skill-dir>/../../scripts/jieli_helper.mjs blame --line <path>:<start>-<end> --cwd <repository>
```

Use `execution` only for a verified exact-SHA executor; `sources` describes patch-equivalent origins and may be ambiguous. Preserve conflicts. Inspect the linked intent timeline and thread before explaining a decision. Original line ranges can be disjoint: do not fill gaps or treat patch-equivalent sources as exact line matches. Report `uncommitted_lines`, `line_mapping_unavailable`, `mirror_unavailable`, `attribution_pending`, and `repo_sync_requires_pro` explicitly. Never infer a missing link from matching titles or file names.
