# Offline cross-repository collector verification

Scope: plugin portions A2–A5 and offline A7 from
`jieli/docs/spec/2026-11-17-cross-repository-provenance.md`.
The verification below was completed before release, without production writes
or transcript-command execution. The collector ships in Codex 0.1.39 and Claude
Code 0.1.31. A8 remains with the main task; no experiment hooks or prototype
files are included in this change.

## Contract

`collectGitEvidence` retains strict `commits` and returns `repositories`,
`commit_references` and `diagnostics`. Provider payload builders already spread
this result. References have the existing CommitEvidence fields; only the
backend assigns `output_reference`. They never become verified execution.

Repository entries prioritize the unanchored initial workspace and one entry
per actual Git root, then use remaining slots for first/last anchored activity.
Message order selects first/last across structured edits and Shell calls, even
though those collection passes run separately. Anchors use the original tool
message, including its timestamp when present. Repeated calls in one repository
do not consume one slot per call. Different worktree/nested roots remain
separate observations; the backend owns repository identity normalization.

Output limits are 256 repository entries, 500 references and 100 diagnostics.
Overflow sets `commits_complete=false` and reports `repositories_truncated`,
`commit_references_truncated` or `diagnostics_truncated`. On diagnostic overflow,
the last slot is reserved for the truncation signal. Other diagnostic codes are
`unsupported_producer`, `producer_not_completed`, `producer_not_successful`,
`ambiguous_commit_summary`, `object_lookup_failed`, `summary_subject_mismatch`.
Partial/running producer output is explicitly incomplete, so it cannot request
replacement of older verified evidence.

Shell decisions use unbash 6.0.4 AST only. Literal cwd/workdir, `git -C` and
proved `cd` success update directory state within one call. Unknown stateful
commands, unsafe conditionals, pipelines/subshell directory changes and dynamic
paths are rejected conservatively. The observation path uses a finite list of
commands known not to change parent-shell state. Its supported opaque producer
includes Python executable paths such as `.venv/bin/python`; a heredoc must be
literal/quoted. References require a completed successful tool, one known Git
repository, unique summaries, resolved local commit objects and matching object
subjects. Standalone Git inspection creates no references. The literal compound
commit case below permits a weaker reference after a nonzero exit; opaque
producers still require successful completion. A producer in its own successful
tool retains its evidence regardless of a later tool's failure.

## Acceptance and evidence

Combined commit/push compatibility (2026-11-18):

- A1: A completed, successful literal Git batch may stage, commit, check
  ancestry, push and check the remote in one call. When existing Shell
  control-flow checks prove execution, the claim points at the original commit
  tool and completion, including async polling; otherwise it is a reference.
- A2: If a bounded batch reports an explicit nonzero exit after printing one
  commit summary, allow only a source reference, subject to local object and
  subject verification. The collector must mark the snapshot incomplete. The
  server must accept the anchored source without accepting a verified claim
  for that failed result, on both upload and scoped replay.
- A3: Skipped commits, results from a different tool, partial output and old
  SHAs printed by inspection commands must not establish a new claim or source.
- A4: The shell parser remains unbash; existing opaque-command rules and
  standalone plugin/history bundle behavior remain intact except that history
  inspection cannot contribute output references. Storing references from
  failed tool results requires a server that supports that evidence; no server
  deployment or production backfill is part of the plugin release.

Verification: `make test` passed (179 passed, 3 skipped); the standalone and
Cloud backend suites both passed. Offline replay recovered the reported
execution claim at the original tool and poll anchors, and the live replay
preview accepted those anchors without applying evidence. The earlier
cross-repository sample still yields only output references. Independent
review could not run because the agent runtime rejected the inherited model.

| Criterion | Implementation / public behavior test | Disposition |
| --- | --- | --- |
| A2 | Literal cd, relative cwd/workdir, Git -C, linked/nested roots, failed/masked/conditional changes, skipped errexit, call isolation | Covered within the conservative AST subset; unsupported syntax stays unlinked |
| A3 plugin | Initial unanchored entry; original message/tool/timestamp anchors; real distinct-root cap; first/last without repeated-call starvation | Covered; backend persistence/visibility belong to main task |
| A4 | Separate Python references, strict evidence retained, standalone inspection/explicit unsupported modes rejected, subject/object/duplicate/multi-repo checks | Covered through collectGitEvidence and both provider buildPayloadFromHook fixtures |
| A5 | Bounded diagnostics/references/repositories; incomplete partial replay; missing-object retry; failed whole tool; reused polling handles; unsupported Git globals / binary paths | Covered; backend replacement policy belongs to main task |
| A7 offline | Original transcript parsed unchanged, real local objects verified, three original SHA/tool pairs; repeated temporary-cache replay | Covered; SQLite HTTP integration belongs to main task |
| Independent review | Main task ran independent requirements/code and test-quality reviews and focused re-reviews | All reported findings closed; disposition is recorded in Jieli's cross-repository spec |

Nameable defects were reproduced red before fixes: missing cd ownership;
unsupported modes rescued as references; masked failures/skipped errexit/exit
creating activity; reused polling handles leaking summaries; missing completion
claiming a complete replay; missing truncation signals; same-repo repetition
starving a distinct repository. Existing strict anti-spoof tests were preserved. Review scores (frequency ×
severity, each 1–10) and disposition:

| Defect | Frequency | Severity | Disposition |
| --- | --- | --- | --- |
| Missing literal cd / relative cwd ownership | 8 | 5 | Fixed |
| Unsupported modes rescued as references | 3 | 5 | Fixed |
| Masked failures, skipped errexit or termination claiming activity | 4 | 5 | Fixed |
| Reused polling handles leaking summaries | 3 | 5 | Fixed |
| Missing completion marked complete | 5 | 7 | Fixed |
| Missing bounds / truncation signals | 3 | 5 | Fixed |
| Repetition starving distinct repositories | 7 | 5 | Fixed |
| Unsupported Git global options / binary paths reported complete | 4 | 7 | Fixed after independent review |

## Recorded commands (2026-11-17)

```sh
npm run build:history
node --test plugins/codex/tests/*.test.mjs plugins/claude-code/tests/*.test.mjs tests/history-sync.test.mjs
node --test --test-name-pattern='unsupported Git producer stays incomplete' plugins/codex/tests/provenance-collection.test.mjs
JIELI_PROVENANCE_LIMIT_TEST=1 node --test --test-name-pattern='output references upload is capped' plugins/codex/tests/provenance-collection.test.mjs
JIELI_PROVENANCE_ROLLOUT=/Users/buru/.codex/sessions/2026/11/17/rollout-2026-11-17T09-40-58-01a1e72a-1954-7811-a924-3d8f2105e830.jsonl node --test tests/offline-provenance.test.mjs
git diff --check
```

Results: build succeeded; provider/hook/trailer/collector/history suite 173
passed, 0 failed, 3 skipped (the pre-existing Codex storage/title metadata test,
the unsupported-Node compressed-input test, and the opt-in 501-object
reference-limit test). The opt-in limit test independently
passed with 501 actual unique commit objects and 500 returned references.
Original-rollout replay passed with 0 strict commits, 3 references, 5 repository
activity entries, 30 diagnostics and `commits_complete=false`; repeat results
were identical. Diff whitespace checks passed.

| SHA | Original tool | Evidence container |
| --- | --- | --- |
| `5e4800c08c3b94da4e7dd0ab5c2f8e41f21e7cbc` | `call_c01479a5733645fcb882e272b46e2363` | `commit_references` |
| `2bea97986035fcdf4346200b5190948affbb49ae` | `call_eb06de9c57df4cfd9e2bdf2ddfd7aaeb` | `commit_references` |
| `aef29c9f753f896f4a7e8a6be1f28bae528fc26e` | `call_9e48b19657d84df6a3504cd5a7cd155c` | `commit_references` |

All three resolve to the local dataServer origin. The offline original replay
uses the exported transcript parser followed by collectGitEvidence, avoiding
the payload builder's existing Codex app-server title lookup for UUID sessions.
Synthetic provider hook tests separately exercise buildPayloadFromHook with
real Python-child Git output and completed polling chains. No transcript is
rewritten to make an evidence claim; no uploader/network endpoint is invoked.

PERF-SCOUT: the 500-reference cold-object fixture takes about 29 seconds here,
with several Git processes per object. A future batch metadata reader could
reduce process launches from O(commits) to a few batches; speedup has not been
measured and no optimization is bundled. Existing cached-success/failure-state
checks continue to avoid unchanged object revalidation.


## Independent-review A5 correction

Finding: frequency 4 × severity 7 = 28. A completed `git --no-pager commit`
or `/usr/bin/git commit` previously went undetected when strict extraction
rejected the command, leaving `commits_complete=true` and allowing older
backend claims to be replaced.

The unbash AST producer scan now classifies the executable by Git basename
and skips standard literal global flags and value-taking options to locate
`commit` / `cherry-pick`. It recognizes `-C` / `-c` (including mixed option
order), pager flags, repository/worktree/namespace/config-env options, and
other standard global flags. It stops at the actual subcommand rather than
searching argument text for the word `commit`. This is detection only:
strict execution extraction and reference eligibility have not expanded.
These previously unsupported forms now emit `unsupported_producer` with
`commits_complete=false`; they create no new strict commits or references.
No `env` or other wrapper handling was added.

Verification: 11 parameterized public collectGitEvidence tests first reproduced
the completeness defect, then passed after the fix. Each uses real Git commits,
retains a previously captured strict claim, and also checks a matching real
read-only Git log that prints a commit-summary-shaped line. Cases cover pager
and other global flags, equals/separate repository options, namespace value
`commit`, config-env, mixed `-C`/`-c`, bare+worktree and absolute Git paths.
The read-only output remains complete and produces no new claims. Git semantics
were exercised on Git 2.54.0 (Apple Git-157), without executing source command
strings. Provider copies were rebuilt; full suite 173 passed / 0 failed /
3 skipped. Original-rollout repeat verification remains 0 strict commits,
3 references, 5 repository entries, 30 diagnostics, incomplete.
