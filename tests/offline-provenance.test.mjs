import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {parseTranscript} from '../plugins/codex/scripts/jieli_node.mjs';
import {collectGitEvidence} from '../scripts/git-provenance.mjs';

test('original rollout links all three dataServer objects offline with original tool anchors', {skip: !process.env.JIELI_PROVENANCE_ROLLOUT}, async t => {
  const transcript = process.env.JIELI_PROVENANCE_ROLLOUT;
  const meta = JSON.parse(readFileSync(transcript, 'utf8').split('\n')[0]).payload;
  const temp = mkdtempSync(join(tmpdir(), 'jieli-offline-provenance-'));
  t.after(() => rmSync(temp, {recursive:true, force:true}));
  {
    const parsed = await parseTranscript(transcript, meta.id);
    const build = () => collectGitEvidence({provider:"codex", sessionId:meta.id, cwd:meta.cwd, messages:parsed.messages, cacheDir:temp});
    const payload = await build();
    const expected = [
      ['5e4800c08c3b94da4e7dd0ab5c2f8e41f21e7cbc', 'call_c01479a5733645fcb882e272b46e2363'],
      ['2bea97986035fcdf4346200b5190948affbb49ae', 'call_eb06de9c57df4cfd9e2bdf2ddfd7aaeb'],
      ['aef29c9f753f896f4a7e8a6be1f28bae528fc26e', 'call_9e48b19657d84df6a3504cd5a7cd155c'],
    ];
    assert.deepEqual(payload.commit_references.map(c => [c.commit_sha, c.commit_tool_use_id]), expected);
    assert.equal(payload.commits.length, 0, 'opaque/mixed producers remain related output references');
    assert.ok(payload.commit_references.every(c => c.git_remote_url.includes('dataServer')));
    assert.ok(payload.repositories.some(r => r.tool_use_id && r.message_id && r.git_root.endsWith('/dataServer')));
    assert.equal(payload.commits_complete, false);
    assert.ok(payload.diagnostics.length > 0 && payload.diagnostics.length <= 100);
    const repeated = await build();
    for (const key of ['repositories', 'commits', 'commit_references', 'diagnostics']) assert.deepEqual(repeated[key], payload[key]);
    t.diagnostic(JSON.stringify({references:expected, repositories:payload.repositories.length, diagnostics:payload.diagnostics}));
  }
});
