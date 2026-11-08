import {describe,expect,test} from 'bun:test';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {lookup} from '@oh-my-pi/pi-coding-agent/config/registry';
import dispatch from '../index.ts';
import {parseRuntimeSettings,readRuntimeSettings} from '../src/ports/runtime-settings.ts';

const VARIABLES=['OMP_DISPATCH_DIR','OMP_DISPATCH_RECOMPUTE_SECONDS','OMP_DISPATCH_MEERKAT_CONFIG'] as const;
const stubApi={registerFlag() {},registerTool() {},registerCommand() {},on() {}} as never;

describe('dispatch runtime settings',()=>{
  test('the extension registers no root settings',()=>{
    dispatch(stubApi);
    for(const key of ['dataDir','recomputeIntervalSeconds','meerkatConfigDir','workflowFile'])expect(lookup(`dispatch.${key}`)).toBeUndefined();
  });

  test('unset settings keep the defaults',()=>{
    expect(parseRuntimeSettings({},{},'/work','/agent/omp-dispatch')).toEqual({ok:true,value:{dataDir:'/agent/omp-dispatch',intervalSeconds:120,meerkat:null}});
  });

  test('plugin settings resolve against the working directory and accept stored strings',()=>{
    expect(parseRuntimeSettings({dataDir:'data',recomputeIntervalSeconds:'30',meerkatConfigDir:' ../meerkat '},{},'/work','/agent/omp-dispatch'))
      .toEqual({ok:true,value:{dataDir:'/work/data',intervalSeconds:30,meerkat:'/meerkat'}});
    expect(parseRuntimeSettings({recomputeIntervalSeconds:45,meerkatConfigDir:'  '},{},'/work','/d')).toEqual({ok:true,value:{dataDir:'/d',intervalSeconds:45,meerkat:null}});
  });

  test('environment variables, empty included, take precedence over plugin settings',()=>{
    expect(parseRuntimeSettings({dataDir:'plug',recomputeIntervalSeconds:30,meerkatConfigDir:'meerkat'},{OMP_DISPATCH_DIR:'envdata',OMP_DISPATCH_RECOMPUTE_SECONDS:'7',OMP_DISPATCH_MEERKAT_CONFIG:''},'/work','/d'))
      .toEqual({ok:true,value:{dataDir:'/work/envdata',intervalSeconds:7,meerkat:null}});
  });

  test('invalid values are refused naming their source',()=>{
    const refused=(raw:Record<string,unknown>,env:Record<string,string>,source:string)=>{
      const result=parseRuntimeSettings(raw,env,'/work','/d');
      expect(result.ok).toBe(false);
      if(!result.ok)expect(result.error).toStartWith(`${source} must be `);
    };
    for(const value of ['  ','',42])refused({dataDir:value},{},'omp-dispatch.dataDir');
    for(const value of [0,-1,1.5,2_147_484,'0','1.5','+3','2147484','12s',''])refused({recomputeIntervalSeconds:value},{},'omp-dispatch.recomputeIntervalSeconds');
    for(const value of [42,true,{}])refused({meerkatConfigDir:value},{},'omp-dispatch.meerkatConfigDir');
    refused({},{OMP_DISPATCH_DIR:' '},'OMP_DISPATCH_DIR');
    refused({recomputeIntervalSeconds:30},{OMP_DISPATCH_RECOMPUTE_SECONDS:'abc'},'OMP_DISPATCH_RECOMPUTE_SECONDS');
    expect(parseRuntimeSettings({recomputeIntervalSeconds:2_147_483},{},'/work','/d')).toMatchObject({ok:true,value:{intervalSeconds:2_147_483}});
  });

  test('the coordinator reads project plugin overrides, and the environment overrides them',async()=>{
    const root=await mkdtemp('/tmp/dispatch-runtime-settings-'),saved=VARIABLES.map(name=>process.env[name]);
    try {
      for(const name of VARIABLES)delete process.env[name];
      await mkdir(join(root,'.omp'));
      const overrides=join(root,'.omp','plugin-overrides.json');
      await writeFile(overrides,JSON.stringify({settings:{'omp-dispatch':{dataDir:'plug',recomputeIntervalSeconds:'30',meerkatConfigDir:'meerkat'}}}));
      expect(await readRuntimeSettings(root)).toEqual({ok:true,value:{dataDir:join(root,'plug'),intervalSeconds:30,meerkat:join(root,'meerkat')}});
      process.env.OMP_DISPATCH_MEERKAT_CONFIG='';process.env.OMP_DISPATCH_DIR='envdata';process.env.OMP_DISPATCH_RECOMPUTE_SECONDS='7';
      expect(await readRuntimeSettings(root)).toEqual({ok:true,value:{dataDir:join(root,'envdata'),intervalSeconds:7,meerkat:null}});
      for(const name of VARIABLES)delete process.env[name];
      await writeFile(overrides,JSON.stringify({settings:{'omp-dispatch':{recomputeIntervalSeconds:'0'}}}));
      expect(await readRuntimeSettings(root)).toMatchObject({ok:false,error:'omp-dispatch.recomputeIntervalSeconds must be whole seconds from 1 to 2147483, not "0"'});
    }finally{
      VARIABLES.forEach((name,index)=>{const value=saved[index];if(value===undefined)delete process.env[name];else process.env[name]=value;});
      await rm(root,{recursive:true,force:true});
    }
  });
});
