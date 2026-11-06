import {describe,expect,test} from 'bun:test';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';

const moduleUrl=new URL('../src/i18n.ts',import.meta.url).href;
async function resolveLanguage(env:Record<string,string>,agentDir?:string):Promise<string> {
  const childEnv={...process.env};
  for(const key of ['OMOMP_LANG','LC_ALL','LC_MESSAGES','LANG'])delete childEnv[key];
  if(agentDir!==undefined)childEnv.PI_CODING_AGENT_DIR=agentDir;
  const child=Bun.spawnSync([process.execPath,'-e',`import {language} from ${JSON.stringify(moduleUrl)}; console.log(language());`],{env:{...childEnv,...env}});
  expect(child.exitCode).toBe(0);
  return child.stdout.toString().trim();
}

describe('three-step interface language',()=>{
  const vectors:[string,Record<string,string>,string][]=[
    ['normalized env',{OMOMP_LANG:' ZH '},'zh'],
    ['invalid env',{OMOMP_LANG:'zh-CN',LANG:'en_US.UTF-8'},'en'],
    ['empty locale skipped',{LC_ALL:'',LC_MESSAGES:'zh_CN.UTF-8'},'zh'],
    ['first locale wins',{LC_ALL:'C',LANG:'zh_CN.UTF-8'},'en'],
    ['final fallback',{},'en'],
    ['env over locale',{OMOMP_LANG:'en',LANG:'zh_CN.UTF-8'},'en'],
    ['locale zh',{LANG:'zh_CN.UTF-8'},'zh'],
  ];
  for(const [name,env,expected] of vectors)test(name,async()=>expect(await resolveLanguage(env)).toBe(expected));
  test('omomp file no longer affects the language',async()=>{
    const root=await mkdtemp('/tmp/roundtable-language-ignored-');
    try {
      await writeFile(join(root,'omomp.yml'),'omomp-lang:\n  language: zh\n');
      expect(await resolveLanguage({LANG:'en_US.UTF-8'},root)).toBe('en');
    }finally{await rm(root,{recursive:true,force:true});}
  });
  test('environment stays live across calls',async()=>{
    const script=`import {language} from ${JSON.stringify(moduleUrl)}; console.log(language()); process.env.OMOMP_LANG=' ZH '; console.log(language()); process.env.LC_ALL='zh_CN.UTF-8'; delete process.env.OMOMP_LANG; console.log(language());`;
    const childEnv={...process.env};
    for(const key of ['OMOMP_LANG','LC_ALL','LC_MESSAGES','LANG'])delete childEnv[key];
    const child=Bun.spawnSync([process.execPath,'-e',script],{env:childEnv});
    expect(child.exitCode).toBe(0);expect(child.stdout.toString().trim().split('\n')).toEqual(['en','zh','zh']);
  });
});
