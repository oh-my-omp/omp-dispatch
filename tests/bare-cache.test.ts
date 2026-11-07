import {describe,expect,test} from 'bun:test';
import {access,chmod,mkdir,mkdtemp,readdir,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from '@oh-my-pi/omptype/zod';
import {checkout,git,lockBare} from '../src/ports/bare-cache.ts';
import type {SeatWorkspace} from '../src/ports/contracts.ts';

const MODULE=new URL('../src/ports/bare-cache.ts',import.meta.url).pathname;
const repo={owner:'test',name:'cache'};
type Spec=Exclude<SeatWorkspace,{kind:'fork'}>;
const base=(name='main'):Spec=>({kind:'base',target:{repo,base:name}});
const commit=(sha:string):Spec=>({kind:'commit',repo,sha,pull:null});
const outcome=z.union([z.object({ok:z.literal(true),tree:z.object({bare:z.string(),path:z.string()})}),z.object({ok:z.literal(false),error:z.string()})]);

/** A data directory, local origin repositories, and a `gh` shim on PATH that clones them; nothing touches the network. */
type Fixture={root:string;origins:string;reposDir:string;worktreesDir:string;env:Record<string,string>};
async function fixture():Promise<Fixture> {
  const root=await mkdtemp('/tmp/dispatch-bare-cache-'),bin=join(root,'bin'),origins=join(root,'origins');
  await mkdir(bin);
  await writeFile(join(bin,'gh'),'#!/bin/sh\n[ "$1" = repo ] && [ "$2" = clone ] || { echo "unexpected gh $*" >&2; exit 2; }\nexec git clone --bare --quiet "$DISPATCH_TEST_ORIGINS/$3.git" "$4"\n');
  await chmod(join(bin,'gh'),0o755);
  const env:Record<string,string>={};
  for(const [key,value] of Object.entries(process.env))if(value!==undefined)env[key]=value;
  Object.assign(env,{PATH:`${bin}:${process.env.PATH}`,DISPATCH_TEST_ORIGINS:origins,GIT_AUTHOR_NAME:'test',GIT_AUTHOR_EMAIL:'test@local',GIT_COMMITTER_NAME:'test',GIT_COMMITTER_EMAIL:'test@local'});
  return {root,origins,reposDir:join(root,'shared','repos'),worktreesDir:join(root,'shared','worktrees'),env};
}
function originGit(f:Fixture,args:string[]):string {
  const run=Bun.spawnSync(['git',...args],{env:f.env});
  if(run.exitCode!==0)throw new Error(`git ${args.join(' ')}: ${run.stderr.toString()}`);
  return run.stdout.toString().trim();
}
/** Creates the origin of `name` with one commit on main, or advances its main by one commit; returns the new head. */
function advance(f:Fixture,name=repo.name):string {
  const origin=join(f.origins,repo.owner,`${name}.git`);
  originGit(f,['init','--bare','--quiet','-b','main',origin]);
  const head=Bun.spawnSync(['git','-C',origin,'rev-parse','--verify','--quiet','refs/heads/main'],{env:f.env}).stdout.toString().trim();
  const tree=originGit(f,['-C',origin,'hash-object','-w','-t','tree','/dev/null']);
  const next=originGit(f,['-C',origin,'commit-tree',tree,'-m',`${name} after ${head||'nothing'}`,...(head?['-p',head]:[])]);
  originGit(f,['-C',origin,'update-ref','refs/heads/main',next]);
  return next;
}
const bareOf=(f:Fixture,name=repo.name)=>join(f.reposDir,`${repo.owner}__${name}.git`);
/** The cache is intact: `fsck` reports nothing, and every listed worktree still has its directory. */
async function intact(bare:string):Promise<void> {
  expect(await git(['-C',bare,'fsck','--no-progress'])).toBe('');
  const list=(await git(['-C',bare,'worktree','list','--porcelain'])).split('\n');
  expect(list.filter(line=>line.startsWith('prunable'))).toEqual([]);
  for(const line of list)if(line.startsWith('worktree '))await access(line.slice('worktree '.length));
  expect((await readdir(bare)).filter(name=>name.endsWith('.lock'))).toEqual([]);
  await access(`${bare}.lock`);
}

/**
 * Each child is a separate coordinator process: it loads the module, reports ready, and checks out once its stdin
 * closes, so every child enters the cache at the same moment.
 */
async function processes(f:Fixture,checkouts:{path:string;spec:Spec}[]):Promise<z.infer<typeof outcome>[]> {
  const driver=join(f.root,'checkout.ts');
  await writeFile(driver,`import {checkout} from ${JSON.stringify(MODULE)};
const [reposDir,path,cwd,spec]=JSON.parse(process.argv[2]);
console.log('ready');
await Bun.stdin.text();
try {console.log(JSON.stringify({ok:true,tree:await checkout(reposDir,path,cwd,spec)}));}
catch(error){console.log(JSON.stringify({ok:false,error:error instanceof Error?error.message:String(error)}));}
`);
  const children=await Promise.all(checkouts.map(async item=>{
    const child=Bun.spawn([process.execPath,driver,JSON.stringify([f.reposDir,item.path,f.root,item.spec])],{env:f.env,stdin:'pipe',stdout:'pipe',stderr:'pipe'});
    const reader=child.stdout.getReader(),decoder=new TextDecoder();let text='';
    while(!text.includes('ready\n')){const chunk=await reader.read();if(chunk.done)throw new Error(`checkout child exited early: ${await new Response(child.stderr).text()}`);text+=decoder.decode(chunk.value);}
    return {child,reader,decoder,text};
  }));
  for(const {child} of children)child.stdin.end();
  return Promise.all(children.map(async ({child,reader,decoder,text})=>{
    for(let chunk=await reader.read();!chunk.done;chunk=await reader.read())text+=decoder.decode(chunk.value);
    expect(await child.exited).toBe(0);
    return outcome.parse(JSON.parse(text.trim().split('\n').at(-1)!));
  }));
}
/**
 * Settles to whether `promise` is still pending after `ms`. A lock that is correctly withheld emits no signal to await,
 * so this one negative observation waits on the real clock.
 */
async function pendingAfter(promise:Promise<unknown>,ms:number):Promise<boolean> {
  let settled=false;promise.then(()=>{settled=true;},()=>{settled=true;});
  await Bun.sleep(ms);
  return !settled;
}
async function inProcess<T>(f:Fixture,work:()=>Promise<T>):Promise<T> {
  const saved={PATH:process.env.PATH,DISPATCH_TEST_ORIGINS:process.env.DISPATCH_TEST_ORIGINS};
  process.env.PATH=f.env.PATH;process.env.DISPATCH_TEST_ORIGINS=f.origins;
  try {return await work();}
  finally {for(const [key,value] of Object.entries(saved))if(value===undefined)delete process.env[key];else process.env[key]=value;}
}

describe('bare repository cache shared by coordinator processes',()=>{
  test('processes cloning a missing cache together wait for the one clone and each check out its own commit',async()=>{
    const f=await fixture();
    try {
      const first=advance(f),second=advance(f);
      const requests=[
        {path:join(f.worktreesDir,'agenda-a','owner'),spec:base(),head:second},
        {path:join(f.worktreesDir,'agenda-b','owner'),spec:commit(first),head:first},
        {path:join(f.worktreesDir,'agenda-c','owner'),spec:base(),head:second},
        {path:join(f.worktreesDir,'agenda-d','owner'),spec:commit(first),head:first},
      ];
      const results=await processes(f,requests);
      expect(results.filter(result=>!result.ok)).toEqual([]);
      for(const [index,request] of requests.entries()){
        expect(results[index]).toEqual({ok:true,tree:{bare:bareOf(f),path:request.path}});
        expect(await git(['-C',request.path,'rev-parse','HEAD'])).toBe(request.head);
      }
      await intact(bareOf(f));
    }finally {await rm(f.root,{recursive:true,force:true});}
  },60_000);

  test('processes fetching an advanced origin together all reach the new head',async()=>{
    const f=await fixture();
    try {
      advance(f);
      await inProcess(f,()=>checkout(f.reposDir,join(f.worktreesDir,'seed','owner'),f.root,base()));
      const head=advance(f);
      const paths=['a','b','c','d'].map(agenda=>join(f.worktreesDir,`agenda-${agenda}`,'owner'));
      const results=await processes(f,paths.map(path=>({path,spec:base()})));
      expect(results.filter(result=>!result.ok)).toEqual([]);
      for(const path of paths)expect(await git(['-C',path,'rev-parse','HEAD'])).toBe(head);
      expect(await git(['-C',bareOf(f),'rev-parse','refs/remotes/origin/main'])).toBe(head);
      await intact(bareOf(f));
    }finally {await rm(f.root,{recursive:true,force:true});}
  },60_000);

  test('one process serializes checkouts of one cache and does not hold back another cache',async()=>{
    const f=await fixture();
    try {
      const a=advance(f,'cache'),b=advance(f,'other');
      const other:Spec={kind:'base',target:{repo:{owner:'test',name:'other'},base:'main'}};
      await inProcess(f,async()=>{
        const held=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>();
        const holder=lockBare(bareOf(f),async()=>{entered.resolve();await held.promise;});
        await entered.promise;
        const waiting=checkout(f.reposDir,join(f.worktreesDir,'agenda-a','owner'),f.root,base());
        expect(await checkout(f.reposDir,join(f.worktreesDir,'agenda-b','owner'),f.root,other)).toEqual({bare:bareOf(f,'other'),path:join(f.worktreesDir,'agenda-b','owner')});
        expect(await pendingAfter(waiting,300)).toBe(true);
        held.resolve();await holder;
        expect((await waiting).path).toBe(join(f.worktreesDir,'agenda-a','owner'));
        const pair=await Promise.all(['c','d'].map(agenda=>checkout(f.reposDir,join(f.worktreesDir,`agenda-${agenda}`,'owner'),f.root,base())));
        for(const tree of pair)expect(await git(['-C',tree.path,'rev-parse','HEAD'])).toBe(a);
      });
      expect(await git(['-C',join(f.worktreesDir,'agenda-b','owner'),'rev-parse','HEAD'])).toBe(b);
      await intact(bareOf(f));await intact(bareOf(f,'other'));
    }finally {await rm(f.root,{recursive:true,force:true});}
  },60_000);

  test('a lock held by a killed process is free at once and leaves nothing in the cache',async()=>{
    const f=await fixture();
    try {
      const head=advance(f);
      await inProcess(f,()=>checkout(f.reposDir,join(f.worktreesDir,'seed','owner'),f.root,base()));
      const driver=join(f.root,'hold.ts');
      // The holder keeps the lock until it is killed; its interval only keeps the process alive.
      await writeFile(driver,`import {lockBare} from ${JSON.stringify(MODULE)};
await lockBare(process.argv[2],()=>{console.log('locked');return new Promise(()=>{setInterval(()=>{},1<<30);});});
`);
      const holder=Bun.spawn([process.execPath,driver,bareOf(f)],{env:f.env,stdout:'pipe',stderr:'pipe'});
      const reader=holder.stdout.getReader(),decoder=new TextDecoder();let text='';
      while(!text.includes('locked\n')){const chunk=await reader.read();if(chunk.done)throw new Error(`holder exited early: ${await new Response(holder.stderr).text()}`);text+=decoder.decode(chunk.value);}
      await inProcess(f,async()=>{
        const waiting=checkout(f.reposDir,join(f.worktreesDir,'agenda-a','owner'),f.root,base());
        expect(await pendingAfter(waiting,500)).toBe(true);
        holder.kill('SIGKILL');
        expect(await holder.exited).not.toBe(0);
        expect((await waiting).path).toBe(join(f.worktreesDir,'agenda-a','owner'));
      });
      expect(await git(['-C',join(f.worktreesDir,'agenda-a','owner'),'rev-parse','HEAD'])).toBe(head);
      await intact(bareOf(f));
    }finally {await rm(f.root,{recursive:true,force:true});}
  },60_000);
});
