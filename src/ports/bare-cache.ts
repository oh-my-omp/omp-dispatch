import {dlopen,FFIType,read} from 'bun:ffi';
import {execFile} from 'node:child_process';
import {access,mkdir,open,rm} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {promisify} from 'node:util';
import type {SeatWorkspace} from './contracts.ts';

const runFile=promisify(execFile);
export type Worktree={bare:string;path:string};
export async function git(args:readonly string[]):Promise<string>{const {stdout}=await runFile('git',[...args]);return stdout.trim();}

const LOCK_EX=2,LOCK_NB=4,EINTR=4,RETRY_MS=20;
type Flock={flock:(fd:number,operation:number)=>number;errno:()=>number;wouldBlock:number};
let kernel:Flock|null=null;
function flock():Flock {
  if(kernel)return kernel;
  if(process.platform==='darwin'){
    const {symbols}=dlopen('/usr/lib/libSystem.B.dylib',{flock:{args:[FFIType.i32,FFIType.i32],returns:FFIType.i32},__error:{args:[],returns:FFIType.ptr}});
    kernel={flock:symbols.flock,errno:()=>read.i32(symbols.__error()!),wouldBlock:35};
  }else if(process.platform==='linux'){
    const {symbols}=dlopen('libc.so.6',{flock:{args:[FFIType.i32,FFIType.i32],returns:FFIType.i32},__errno_location:{args:[],returns:FFIType.ptr}});
    kernel={flock:symbols.flock,errno:()=>read.i32(symbols.__errno_location()!),wouldBlock:11};
  }else throw new Error(`Repository cache locking needs flock(2), which ${process.platform} does not provide`);
  return kernel;
}

/**
 * Runs `work` while holding the exclusive flock(2) on `<bare>.lock`. Every coordinator process sharing the data
 * directory takes this lock, so all git operations on one bare cache run in order across processes; different caches
 * never wait on each other. The kernel releases the lock when its descriptor closes or its process dies. The lock file
 * sits beside the cache because a cache without HEAD is removed and cloned anew as a whole.
 */
export async function lockBare<T>(bare:string,work:()=>Promise<T>):Promise<T> {
  const system=flock(),path=`${bare}.lock`;
  await mkdir(dirname(path),{recursive:true,mode:0o700});
  const handle=await open(path,'a',0o600);
  try {
    // A blocking flock(2) would stall this whole process, every other seat included, until the holder finishes.
    while(system.flock(handle.fd,LOCK_EX|LOCK_NB)!==0){
      const errno=system.errno();
      if(errno!==system.wouldBlock&&errno!==EINTR)throw new Error(`Cannot lock ${path}: flock failed with errno ${errno}`);
      await sleep(RETRY_MS);
    }
    return await work();
  }finally {await handle.close();}
}

/**
 * A detached worktree at `path` of the repository's bare cache under `reposDir`, at exactly the commit the seat must
 * build on or judge. The cache is cloned once and fetched before every checkout; seats never clone from the network.
 */
export function checkout(reposDir:string,path:string,cwd:string,spec:Exclude<SeatWorkspace,{kind:'fork'}>):Promise<Worktree> {
  const repo=spec.kind==='base'?spec.target.repo:spec.repo;
  const bare=join(reposDir,`${repo.owner}__${repo.name}.git`.toLowerCase());
  return lockBare(bare,async()=>{
    if(!await access(join(bare,'HEAD')).then(()=>true,()=>false)){
      await rm(bare,{recursive:true,force:true});
      await runFile('gh',['repo','clone',`${repo.owner}/${repo.name}`,bare,'--','--bare','--quiet'],{cwd});
      // A bare clone has no remote-tracking refspec; worktrees then fetch and track origin like an ordinary clone.
      await git(['-C',bare,'config','remote.origin.fetch','+refs/heads/*:refs/remotes/origin/*']);
    }
    await git(['-C',bare,'fetch','--prune','--quiet','origin']);
    let commit:string;
    if(spec.kind==='base')commit=await git(['-C',bare,'rev-parse','--verify',`refs/remotes/origin/${spec.target.base}^{commit}`]);
    else {
      // A fork PR head lives only under the base repository's pull ref, not its branches.
      if(spec.pull!==null)await git(['-C',bare,'fetch','--quiet','origin',`+refs/pull/${spec.pull}/head:refs/dispatch/pull/${spec.pull}`]);
      commit=spec.sha;
    }
    const tree={bare,path};
    await mkdir(dirname(tree.path),{recursive:true,mode:0o700});
    await git(['-C',bare,'worktree','add','--detach','--quiet',tree.path,`${commit}^{commit}`]);
    const head=await git(['-C',tree.path,'rev-parse','HEAD']);
    if(head!==commit){await git(['-C',bare,'worktree','remove','--force',tree.path]);throw new Error(`Seat worktree is at ${head}, not the required ${commit}`);}
    return tree;
  });
}
