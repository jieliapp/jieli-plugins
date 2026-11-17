import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, renameSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import * as codex from '../scripts/jieli_node.mjs';
import * as claude from '../../claude-code/scripts/jieli_node.mjs';
import { withEnv } from '../../test_helpers/runtime.mjs';

for (const provider of ['codex','claude']) test(`${provider}: capture root commit without trailers and retain cached evidence after workspace removal`, async t => {
 const temp=mkdtempSync(join(tmpdir(),'jieli-provenance-')); t.after(()=>rmSync(temp,{recursive:true,force:true})); const cwd=join(temp,'repo');
 const git=(...args)=>{const r=spawnSync('git',args,{cwd:temp,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
 git('init','-b','main',cwd);const run=(...args)=>{const r=spawnSync('git',args,{cwd,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
 run('config','user.name','Test');run('config','user.email','test@example.test');run('remote','add','origin','ssh://git@github.com:22/acme/project.git');
 writeFileSync(join(cwd,'file.txt'),'first change\n');run('add','file.txt');const output=run('commit','-m','Initial change');const sha=run('rev-parse','HEAD');
 const stamp='2026-11-02T00:00:00.000Z';const transcript=join(temp,'session.jsonl');
 const entries=provider==='codex' ? [
  {type:'session_meta',timestamp:stamp,payload:{id:'provenance',cwd}},
  {type:'response_item',timestamp:stamp,payload:{type:'message',role:'user',id:'u',content:[{type:'input_text',text:'Make this change'}]}},
  {type:'response_item',timestamp:stamp,payload:{type:'function_call',call_id:'call',name:'functions.exec_command',arguments:JSON.stringify({cmd:'git commit -m "Initial change"',workdir:cwd})}},
  {type:'response_item',timestamp:stamp,payload:{type:'function_call_output',call_id:'call',output:`Process exited with code 0\nFinal output:\n${output}`}},
 ] : [
  {type:'user',uuid:'u',sessionId:'provenance',cwd,timestamp:stamp,message:{role:'user',content:'Make this change'}},
  {type:'assistant',uuid:'call-message',cwd,timestamp:stamp,message:{role:'assistant',content:[{type:'tool_use',id:'call',name:'Bash',input:{command:'git commit -m "Initial change"'}}]}},
  {type:'user',uuid:'result-message',cwd,timestamp:stamp,message:{role:'user',content:[{type:'tool_result',tool_use_id:'call',content:output}]}},
 ];
 writeFileSync(transcript,entries.map(JSON.stringify).join('\n'));
 await withEnv({HOME:temp},async()=>{
  const runtime=provider==='codex'?codex:claude;const build=()=>runtime.buildPayloadFromHook({transcript_path:transcript,session_id:'provenance',cwd},'https://jieli.example.test',null,...(provider==='codex'?[null,{includeSummaryStats:false}]:[{includeSummaryStats:false}]));
  const first=await build();assert.equal(first.git_remote_url,'ssh://git@github.com:22/acme/project.git');assert.equal(first.git_root,cwd);assert.equal(first.commits[0].commit_sha,sha);assert.deepEqual(first.commits[0].files,['file.txt']);assert.equal(first.thread.messages[0].timestamp_ms,1793577600000);
  assert.notEqual(first.thread.messages.at(-1).message_id,first.thread.messages.at(-2).message_id);
  renameSync(cwd,join(temp,'removed'));
  const second=await build();assert.deepEqual(second.commits,first.commits,'captured success must survive local object/workspace removal');
 });
});

for (const provider of ['codex', 'claude-code']) test(`${provider}: standalone plugin captures a literal batch without source dependencies`, async (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'jieli-standalone-provenance-'));
  t.after(() => rmSync(temp, {recursive:true, force:true}));
  const cwd = join(temp, 'repo space');
  const git = (...args) => {
    const r = spawnSync('git', args, {encoding:'utf8'});
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git('init', '-b', 'main', cwd);
  git('-C', cwd, 'config', 'user.name', 'Test');
  git('-C', cwd, 'config', 'user.email', 'test@example.test');
  git('-C', cwd, 'remote', 'add', 'origin', 'git@github.com:acme/standalone.git');
  const command = "git -C ../repo\\ space commit --allow-empty -m done && git -C ../repo\\ space commit --allow-empty -m 'then'";
  const executed = spawnSync('/bin/sh', ['-c', command], {cwd, encoding:'utf8'});
  assert.equal(executed.status, 0, executed.stderr);
  const shas = [git('-C', cwd, 'rev-parse', 'HEAD^'), git('-C', cwd, 'rev-parse', 'HEAD')];
  const standalone = join(temp, 'plugin');
  cpSync(fileURLToPath(new URL(`../../${provider}/scripts`, import.meta.url)), standalone, {recursive:true});
  const runtime = await import(pathToFileURL(join(standalone, 'jieli_node.mjs')));
  const transcript = join(temp, 'session.jsonl');
  const entries = provider === 'codex' ? [
    {type:'session_meta', payload:{id:'batch', cwd}},
    {type:'response_item', payload:{type:'function_call', call_id:'call', name:'exec_command', arguments:JSON.stringify({cmd:command, workdir:cwd})}},
    {type:'response_item', payload:{type:'function_call_output', call_id:'call', output:`Process exited with code 0\nFinal output:\n${executed.stdout}`}},
  ] : [
    {type:'assistant', uuid:'call-message', sessionId:'batch', cwd, message:{role:'assistant', content:[{type:'tool_use', id:'call', name:'Bash', input:{command}}]}},
    {type:'user', uuid:'result-message', sessionId:'batch', cwd, message:{role:'user', content:[{type:'tool_result', tool_use_id:'call', content:executed.stdout}]}},
  ];
  writeFileSync(transcript, entries.map(JSON.stringify).join('\n'));
  await withEnv({HOME:temp}, async () => {
    const payload = await runtime.buildPayloadFromHook({transcript_path:transcript, session_id:'batch', cwd}, 'https://jieli.example.test', null,
      ...(provider === 'codex' ? [null, {includeSummaryStats:false}] : [{includeSummaryStats:false}]));
    assert.deepEqual(payload.commits.map(c => c.commit_sha), shas);
    assert.ok(payload.commits.every(c => c.commit_tool_use_id === 'call' && c.start_message_id === c.commit_message_id));
    assert.equal(payload.commits_complete, true);
  });
});

for (const provider of ['codex', 'claude-code']) test(`${provider}: hook payload keeps Python output references separate through repeated polls`, async t => {
  const temp = mkdtempSync(join(tmpdir(), 'jieli-opaque-hook-'));
  t.after(() => rmSync(temp, {recursive:true, force:true}));
  const cwd = join(temp, 'repo');
  const git = (...args) => {
    const r = spawnSync('git', args, {encoding:'utf8'});
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git('init', '-b', 'main', cwd);
  git('-C', cwd, 'config', 'user.name', 'Test');
  git('-C', cwd, 'config', 'user.email', 'test@example.test');
  git('-C', cwd, 'remote', 'add', 'origin', 'git@github.com:acme/opaque.git');
  const program = "import subprocess\nsubprocess.run(['git', 'commit', '--allow-empty', '-m', 'child commit'], check=True)";
  const executed = spawnSync('python3', ['-c', program], {cwd, encoding:'utf8'});
  assert.equal(executed.status, 0, executed.stderr);
  const sha = git('-C', cwd, 'rev-parse', 'HEAD');
  const command = `python3 - <<'PY'\n${program}\nPY`;
  const entries = provider === 'codex' ? [
    {type:'session_meta', payload:{id:'opaque', cwd}},
    {type:'response_item', payload:{type:'function_call', call_id:'child', name:'exec_command', arguments:JSON.stringify({cmd:command, workdir:cwd})}},
    {type:'response_item', payload:{type:'function_call_output', call_id:'child', output:'Process running with session ID 12\n'}},
    {type:'response_item', payload:{type:'function_call', call_id:'progress', name:'write_stdin', arguments:JSON.stringify({session_id:12, chars:''})}},
    {type:'response_item', payload:{type:'function_call_output', call_id:'progress', output:`Process running with session ID 12\n${executed.stdout}`}},
    {type:'response_item', payload:{type:'function_call', call_id:'finish', name:'write_stdin', arguments:JSON.stringify({session_id:12, chars:''})}},
    {type:'response_item', payload:{type:'function_call_output', call_id:'finish', output:'Process exited with code 0\nFinal output:\n'}},
  ] : [
    {type:'assistant', uuid:'child-message', sessionId:'opaque', cwd, message:{role:'assistant', content:[{type:'tool_use', id:'child', name:'Bash', input:{command, cwd}}]}},
    {type:'user', uuid:'result-message', sessionId:'opaque', cwd, message:{role:'user', content:[{type:'tool_result', tool_use_id:'child', content:executed.stdout}]}},
  ];
  const transcript = join(temp, 'session.jsonl');
  writeFileSync(transcript, entries.map(JSON.stringify).join('\n'));
  const runtime = provider === 'codex' ? codex : claude;
  await withEnv({HOME:temp}, async () => {
    const build = () => runtime.buildPayloadFromHook({transcript_path:transcript, session_id:'opaque', cwd}, 'https://offline.invalid', null,
      ...(provider === 'codex' ? [null, {includeSummaryStats:false}] : [{includeSummaryStats:false}]));
    const p = await build();
    assert.deepEqual(p.commits, []);
    assert.deepEqual(p.commit_references.map(c => [c.commit_sha, c.commit_tool_use_id]), [[sha, 'child']]);
    assert.equal(p.commits_complete, false);
    assert.ok(p.repositories.some(r => r.tool_use_id === 'child' && r.message_id));
    const again = await build();
    assert.deepEqual(again.commit_references, p.commit_references);
  });
});
