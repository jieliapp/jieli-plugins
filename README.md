# Jieli Plugins

Plugins for syncing AI coding sessions to [Jieli](https://jieli.app).

## Claude Code Install

Run these in your shell:

```bash
claude plugin marketplace add jieliapp/plugins
claude plugin install jieli@jieliapp
```

## Codex Install

Run these in your shell:

```bash
codex plugin marketplace add jieliapp/plugins
codex plugin add jieli@jieliapp
```

Then enable the plugin and trust its hooks with `/hooks`.

## Configuration

Both plugins use `https://jieli.app` by default. Get an API key from [Jieli](https://jieli.app), or from your own Jieli instance if you self-host. For a self-hosted instance, set the base URL to its full access address, including `https://` or `http://`, and use an API key created on that same instance.

You can set environment variables before starting Claude Code or Codex:

```bash
export JIELI_API_KEY="your-jieli-api-key"
# Optional; defaults to https://jieli.app. Change this for self-hosted Jieli.
export JIELI_BASE_URL="https://jieli.app"
```

Recommended for both Claude Code and Codex: write this file, which works even after the agent is already running:

Path: `~/.config/jieli/settings.json`

```json
{
  "api_key": "your-jieli-api-key",
  "base_url": "https://jieli.app",
  "commit_trailer": true
}
```

`base_url` is optional and defaults to `https://jieli.app`. For self-hosted Jieli, replace it with your instance's URL, such as `https://jieli.example.com`. `JIELI_BASE_URL` takes precedence over this setting.

`commit_trailer` is optional and defaults to `true`. Set it to `false` to disable the automatic `Jieli-Thread` trailer added by the `PreToolUse` hook.

## What It Does

- Syncs Claude Code sessions to Jieli threads.
- Syncs local Codex sessions to Jieli threads.
- Uploads pasted local images as Jieli attachments.
- Adds best-effort `Jieli-Thread` trailers to simple Claude Code and Codex `git commit` commands.
- Provides the `jieli-read-thread` skill for reading known Jieli thread links or ids.
- Provides the `jieli-find-thread` skill for searching synced Jieli threads by keywords, repo, file, topic, or clues.
- Provides the `handoff` skill for creating a paste-ready continuation prompt for a fresh agent, including the current Jieli thread id and URL when available.
- Redacts common secrets before upload.

## Redaction

Secrets are redacted locally before anything is uploaded. Each match is replaced
with a typed marker like `[REDACTED:openai-api-key]`, so the conversation stays
readable while the secret value is gone.

Covered: vendor API keys and tokens, private keys, JWTs, `Bearer` headers,
credentials in connection URLs, and sensitive `KEY=value` assignments in
env/JSON/YAML. Base64 image data is left intact.

This is best-effort pattern matching, not a guarantee. See the patterns in
`plugins/*/scripts/jieli_node.mjs` (covered by `make test`).

## Development

```bash
make test
make validate
```
