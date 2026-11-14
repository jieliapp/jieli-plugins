import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
