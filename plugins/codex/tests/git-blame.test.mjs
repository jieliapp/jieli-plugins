import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseBlame } from '../scripts/git_blame.mjs';

test('blame preserves disjoint original ranges through real Git and requests only exact coordinates',async t=>{
 const temp=mkdtempSync(join(tmpdir(),'jieli-blame-'));t.after(()=>rmSync(temp,{recursive:true,force:true}));
 const env={...process.env,HOME:temp,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_AUTHOR_NAME:'Test',GIT_AUTHOR_EMAIL:'test@example.com',GIT_COMMITTER_NAME:'Test',GIT_COMMITTER_EMAIL:'test@example.com'};
 const git=(...args)=>execFileSync('git',args,{cwd:temp,env,encoding:'utf8'}).trim();
 git('init','-b','main');git('config','remote.origin.url','https://user:secret-marker@example.com/org/project.git');
 writeFileSync(join(temp,'file.txt'),'one unique original\ntwo unique original\nthree unique original\nfour unique original\nfive unique original\n');git('add','.');git('-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null','commit','-m','initial');const sha=git('rev-parse','HEAD');
 writeFileSync(join(temp,'file.txt'),'two unique original\nfive unique original\n');git('add','.');git('-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null','commit','-m','remove lines');
 const grouped=parseBlame(git('blame','--line-porcelain','--','file.txt'));
 assert.equal(grouped.length,1);assert.equal(grouped[0].sha,sha);assert.deepEqual(grouped[0].ranges,[{start:2,end:2},{start:5,end:5}]);
 let exact=false;const requests=[];const server=createServer((req,res)=>{const url=new URL(req.url,'http://localhost');requests.push(url);assert.equal(req.headers.authorization,'Bearer test-key');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({success:true,data:{execution:{status:exact?'verified':'none'},sources:{status:url.searchParams.has('patch_id')?'linked':'none',items:[]},line_matches_unavailable_reason:'line_mapping_unavailable'}}));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
 const run=async line=>{
  const child=spawn(process.execPath,[resolve('plugins/codex/scripts/jieli_helper.mjs'),'blame','--line',line,'--cwd',temp],{env:{...env,JIELI_API_KEY:'test-key',JIELI_BASE_URL:`http://127.0.0.1:${server.address().port}`},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);const exit=await new Promise(resolve=>child.on('close',resolve));assert.equal(exit,0,stderr);assert.ok(!stdout.includes('secret-marker'));return stdout;
 };
 const stdout=await run('file.txt:1-2');

 const result=JSON.parse(stdout);assert.equal(requests.length,2);for(const url of requests){assert.equal(url.searchParams.get('ranges'),'2-2,5-5');assert.equal(url.searchParams.get('path'),'file.txt');assert.equal(url.searchParams.get('sha'),sha);assert.equal(url.searchParams.get('repo'),'https://example.com/org/project.git');}
 assert.match(requests[1].searchParams.get('patch_id'),/^[a-f0-9]{40}$/);assert.equal(result.results[0].line_matches_unavailable_reason,'line_mapping_unavailable');
 requests.length=0;exact=true;await run('file.txt:1');assert.equal(requests.length,1,'exact match must not query PatchID');
 requests.length=0;writeFileSync(join(temp,'file.txt'),'two unique original\nfive unique original\nuncommitted text\n');const local=JSON.parse(await run('file.txt:3'));assert.equal(requests.length,0);assert.equal(local.results[0].reason,'uncommitted_lines');
 git('restore','file.txt');git('mv','file.txt','renamed.txt');git('-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null','commit','-m','rename');requests.length=0;await run('renamed.txt:1');assert.equal(requests[0].searchParams.get('path'),'file.txt','Git original path must survive rename');

});

test('blame decodes Git octal UTF-8 filenames',()=>{
 const rows=parseBlame('a'.repeat(40)+' 2 1 1\nfilename "\\303\\251.txt"\n\tline\n');assert.equal(rows[0].path,'é.txt');
});
