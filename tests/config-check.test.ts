import {describe,expect,test} from 'bun:test';
import {validatePmFiles} from '../src/pm/config.ts';
import {serveConfigCheck} from '../src/launcher/config-check.ts';
import {parseConfigCheckSettings} from '../src/launcher/settings.ts';

const SIM=new URL('./sim/pm-config/',import.meta.url);
const validDelivery='guardiansURL: http://127.0.0.1:7410\ndefaultTier: simple\ntierHelp: x\nresumePrompt: y\n';

async function validFiles():Promise<Record<string,string>> {
  return {
    'shared/repos.yaml':await Bun.file(new URL('shared/repos.yaml',SIM)).text(),
    'shared/project.yaml':await Bun.file(new URL('shared/project.yaml',SIM)).text(),
    'dispatch/delivery.yaml':validDelivery,
  };
}

describe('validatePmFiles',()=>{
  test('the valid set passes and yields the three parts',async()=>{
    const checked=validatePmFiles(await validFiles());
    expect(checked.ok).toBe(true);
    if(checked.ok)expect(checked.value.delivery.defaultTier).toBe('simple');
  });

  test('an unknown key names its file and key',async()=>{
    const files=await validFiles();
    files['dispatch/delivery.yaml']=`${validDelivery}extra: 1\n`;
    const checked=validatePmFiles(files);
    expect(checked.ok).toBe(false);
    if(!checked.ok)expect(checked.error).toEqual([expect.objectContaining({file:'dispatch/delivery.yaml',key:'extra'})]);
  });

  test('a missing key names its file and key',async()=>{
    const files=await validFiles();
    files['dispatch/delivery.yaml']=validDelivery.replace('resumePrompt: y\n','');
    const checked=validatePmFiles(files);
    expect(checked.ok).toBe(false);
    if(!checked.ok)expect(checked.error).toEqual([expect.objectContaining({file:'dispatch/delivery.yaml',key:'resumePrompt'})]);
  });

  test('a missing referenced file is refused as the file itself',async()=>{
    const files=await validFiles();
    delete files['shared/repos.yaml'];
    const checked=validatePmFiles(files);
    expect(checked.ok).toBe(false);
    if(!checked.ok)expect(checked.error).toEqual([{file:'shared/repos.yaml',key:'(file)',message:'is missing'}]);
  });

  test('a file that is not one of the three PM files is refused',async()=>{
    const files={...await validFiles(),'shared/extra.yaml':'a: 1\n'};
    const checked=validatePmFiles(files);
    expect(checked.ok).toBe(false);
    if(!checked.ok)expect(checked.error).toEqual([expect.objectContaining({file:'shared/extra.yaml',key:'(file)'})]);
  });

  test('a value outside its enum names the key',async()=>{
    const files=await validFiles();
    files['dispatch/delivery.yaml']=validDelivery.replace('defaultTier: simple','defaultTier: urgent');
    const checked=validatePmFiles(files);
    expect(checked.ok).toBe(false);
    if(!checked.ok)expect(checked.error).toEqual([expect.objectContaining({file:'dispatch/delivery.yaml',key:'defaultTier'})]);
  });
});

describe('config check settings',()=>{
  test('unset settings take the declared defaults',()=>{
    expect(parseConfigCheckSettings({})).toEqual({ok:true,value:{host:'127.0.0.1',port:47593}});
  });

  test('a port equal to the link port or the webhook port disables only this listener',()=>{
    for(const raw of [{configCheckPort:47591},{configCheckPort:47592},{webhookPort:47600,configCheckPort:47600},{configCheckPort:0},{configCheckPort:'47593'},{configCheckHost:''}])
      expect(parseConfigCheckSettings(raw).ok).toBe(false);
  });

  test('a custom port and host are accepted and trimmed',()=>{
    expect(parseConfigCheckSettings({configCheckHost:' 127.0.0.2 ',configCheckPort:48000})).toEqual({ok:true,value:{host:'127.0.0.2',port:48000}});
  });
});

describe('config check listener',()=>{
  test('judges candidates over POST, refuses bad requests and methods, and answers preflight',async()=>{
    const logs:Readonly<Record<string,unknown>>[]=[];
    const listener=await serveConfigCheck({host:'127.0.0.1',port:0,log:entry=>logs.push(entry)});
    const url=`http://127.0.0.1:${listener.port}/pm-config/check`;
    try {
      const files=await validFiles();
      const ok=await fetch(url,{method:'POST',body:JSON.stringify({files})});
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ok:true});
      expect(ok.headers.get('access-control-allow-origin')).toBe('*');

      files['dispatch/delivery.yaml']=`${validDelivery}extra: 1\n`;
      const bad=await fetch(url,{method:'POST',body:JSON.stringify({files})});
      expect(bad.status).toBe(200);
      expect(await bad.json()).toEqual({ok:false,errors:[expect.objectContaining({file:'dispatch/delivery.yaml',key:'extra'})]});

      expect((await fetch(url,{method:'POST',body:'{"files":{}}'})).status).toBe(400);
      expect((await fetch(url,{method:'POST',body:'not json'})).status).toBe(400);
      expect((await fetch(url)).status).toBe(405);
      const preflight=await fetch(url,{method:'OPTIONS',headers:{Origin:'http://example.test','Access-Control-Request-Method':'POST'}});
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
      expect(logs.some(entry=>entry.outcome==='listening')).toBe(true);
    } finally {await listener.close();}
  });
});
