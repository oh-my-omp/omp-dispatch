import {describe,expect,test} from 'bun:test';
import {createHmac} from 'node:crypto';
import type {RunResult,Runner} from '../src/launcher/exec.ts';
import {type TriggerSettings,decideIssuesEvent} from '../src/launcher/trigger.ts';
import {serveWebhook,validSignature} from '../src/launcher/webhook.ts';
import {parseLauncherSettings} from '../src/launcher/settings.ts';

const link=(reference:{owner:string;repo:string;number:number},cwd='/tmp'):string=>
  `http://127.0.0.1:47591/${reference.owner}/${reference.repo}/issues/${reference.number}?spec=${encodeURIComponent(JSON.stringify({cwd,frontend:{kind:'tern'}}))}`;
const own=link({owner:'Acme',repo:'dispatch',number:7});
const badge=(url:string):string=>`Plan\n\n[![Coordinate with Dispatch](https://example.com/badge.svg)](${url})`;

type Issue={body:string|null;labels?:readonly string[];state?:string;association?:string};
function delivery(action:string,issue:Issue,extra:Readonly<Record<string,unknown>>={}):unknown {
  return {action,repository:{name:'dispatch',owner:{login:'Acme'}},sender:{login:'someone'},
    issue:{number:7,state:issue.state??'open',body:issue.body,author_association:issue.association??'OWNER',labels:(issue.labels??[]).map(name=>({name}))},...extra};
}

const linkMode:TriggerSettings={mode:'link',labels:[],associations:['OWNER','MEMBER','COLLABORATOR']};
const labelMode=(labels:readonly string[]):TriggerSettings=>({...linkMode,mode:'label',labels});

describe('trigger decision',()=>{
  test('link mode starts the linked issue when it is opened by an allowed author',async()=>{
    const decision=await decideIssuesEvent(delivery('opened',{body:badge(own)}),linkMode);
    expect(decision.kind).toBe('launch');
    if(decision.kind==='launch')expect(decision.target).toMatchObject({reference:'Acme/dispatch#7',cwd:'/tmp',frontend:{kind:'tern'}});
  });

  test('refuses authors outside the configured associations, matching case-insensitively',async()=>{
    expect((await decideIssuesEvent(delivery('opened',{body:badge(own),association:'NONE'}),linkMode)).kind).toBe('ignored');
    expect((await decideIssuesEvent(delivery('opened',{body:badge(own),association:'CONTRIBUTOR'}),linkMode)).kind).toBe('ignored');
    expect((await decideIssuesEvent(delivery('opened',{body:badge(own),association:'CONTRIBUTOR'}),{...linkMode,associations:['contributor']})).kind).toBe('launch');
  });

  test('a link to another issue, a closed issue, or an invalid link starts nothing',async()=>{
    expect((await decideIssuesEvent(delivery('opened',{body:badge(link({owner:'Acme',repo:'dispatch',number:8}))}),linkMode)).kind).toBe('ignored');
    expect((await decideIssuesEvent(delivery('reopened',{body:badge(own),state:'closed'}),linkMode)).kind).toBe('ignored');
    expect((await decideIssuesEvent(delivery('opened',{body:badge(link({owner:'Acme',repo:'dispatch',number:7},'/nonexistent-omp-dispatch-check'))}),linkMode)).kind).toBe('ignored');
    expect((await decideIssuesEvent(delivery('opened',{body:null}),linkMode)).kind).toBe('ignored');
  });

  test('an edit starts a coordinator only when it adds the link',async()=>{
    expect((await decideIssuesEvent(delivery('edited',{body:badge(own)},{changes:{body:{from:'Plan'}}}),linkMode)).kind).toBe('launch');
    expect((await decideIssuesEvent(delivery('edited',{body:`${badge(own)}\nmore`},{changes:{body:{from:badge(own)}}}),linkMode)).kind).toBe('ignored');
    expect((await decideIssuesEvent(delivery('edited',{body:badge(own)},{changes:{title:{from:'Old'}}}),linkMode)).kind).toBe('ignored');
  });

  test('label mode needs a configured label as well as the link',async()=>{
    const settings=labelMode(['Dispatch']);
    expect((await decideIssuesEvent(delivery('opened',{body:badge(own)}),settings)).kind).toBe('ignored');
    expect((await decideIssuesEvent(delivery('labeled',{body:badge(own),labels:['dispatch']},{label:{name:'dispatch'}}),settings)).kind).toBe('launch');
    expect((await decideIssuesEvent(delivery('labeled',{body:badge(own),labels:['bug']},{label:{name:'bug'}}),settings)).kind).toBe('ignored');
    expect((await decideIssuesEvent(delivery('labeled',{body:'Plan',labels:['dispatch']},{label:{name:'dispatch'}}),settings)).kind).toBe('ignored');
    expect((await decideIssuesEvent(delivery('labeled',{body:badge(own),labels:['dispatch','bug']},{label:{name:'bug'}}),settings)).kind).toBe('ignored');
  });

  test('label mode with no configured label starts on the first label only',async()=>{
    const settings=labelMode([]);
    expect((await decideIssuesEvent(delivery('labeled',{body:badge(own),labels:['bug']},{label:{name:'bug'}}),settings)).kind).toBe('launch');
    expect((await decideIssuesEvent(delivery('labeled',{body:badge(own),labels:['bug','ui']},{label:{name:'ui'}}),settings)).kind).toBe('ignored');
  });

  test('other actions and malformed deliveries start nothing',async()=>{
    expect((await decideIssuesEvent(delivery('closed',{body:badge(own)}),linkMode)).kind).toBe('ignored');
    expect((await decideIssuesEvent({action:'opened'},linkMode)).kind).toBe('ignored');
  });
});

describe('webhook listener',()=>{
  const secret='test-secret';
  const sign=(body:string):string=>`sha256=${createHmac('sha256',secret).update(body).digest('hex')}`;

  test('accepts only the exact bytes signed with the App secret',()=>{
    const body=new TextEncoder().encode('{"a":1}');
    expect(validSignature(secret,body,sign('{"a":1}'))).toBe(true);
    expect(validSignature(secret,body,sign('{"a":2}'))).toBe(false);
    expect(validSignature(secret,body,'sha256=00')).toBe(false);
    expect(validSignature(secret,body,undefined)).toBe(false);
  });

  test('a signed issues delivery launches through the linked frontend; an unsigned one is refused',async()=>{
    const commands:string[]=[];
    const launched=Promise.withResolvers<void>();
    const runner:Runner=async(command,args)=>{
      const key=`${command} ${args.join(' ')}`;commands.push(key);
      const reply=(stdout:string):RunResult=>({code:0,stdout,stderr:''});
      if(key==='tern inspect --json')return reply(JSON.stringify({clients:[{kind:'window'}]}));
      if(key==='tern ls --json')return reply(JSON.stringify({sessions:[]}));
      launched.resolve();return reply('');
    };
    const entries:Readonly<Record<string,unknown>>[]=[];
    const listener=await serveWebhook({host:'127.0.0.1',port:0,runner,log:entry=>{entries.push(entry);},
      registration:async()=>({ok:true,value:{kind:'present',app:{id:1,slug:'s',name:'n',owner:'o',htmlUrl:'https://github.com/apps/s',webhookSecret:secret,pem:'',clientId:'',clientSecret:''}}}),
      settings:async()=>({ok:true,value:linkMode})});
    try {
      const url=`http://127.0.0.1:${listener.port}/github/webhook`;
      const body=JSON.stringify(delivery('opened',{body:badge(own)}));
      const unsigned=await fetch(url,{method:'POST',body,headers:{'x-github-event':'issues'}});
      expect(unsigned.status).toBe(401);
      const signed=await fetch(url,{method:'POST',body,headers:{'x-github-event':'issues','x-hub-signature-256':sign(body)}});
      expect(signed.status).toBe(202);
      expect(await signed.json()).toEqual({outcome:'launching',detail:'Acme/dispatch#7'});
      await launched.promise;
      expect(commands).toContain('tern new tab --cwd /tmp -- omp --dispatch Acme/dispatch#7');
      const ping=await fetch(url,{method:'POST',body:'{}',headers:{'x-github-event':'ping','x-hub-signature-256':sign('{}')}});
      expect(ping.status).toBe(200);
    } finally {await listener.close();}
  });
});

describe('launcher settings',()=>{
  test('unset settings take the declared defaults',()=>{
    expect(parseLauncherSettings({})).toEqual({ok:true,value:{trigger:{mode:'link',labels:[],associations:['OWNER','MEMBER','COLLABORATOR']},webhook:{host:'127.0.0.1',port:47592}}});
  });

  test('lists are comma-separated and trimmed',()=>{
    const parsed=parseLauncherSettings({githubTrigger:'label',githubTriggerLabels:' dispatch , ready ,',githubTriggerAssociations:'OWNER, CONTRIBUTOR'});
    expect(parsed.ok&&parsed.value.trigger).toEqual({mode:'label',labels:['dispatch','ready'],associations:['OWNER','CONTRIBUTOR']});
  });

  test('refuses values that would disable or collide silently',()=>{
    for(const raw of [{githubTrigger:'any'},{githubTriggerAssociations:' , '},{webhookPort:47591},{webhookPort:'47591'},{webhookPort:0},{webhookPort:'47592x'},{webhookPort:'4.5'},{webhookHost:''}])
      expect(parseLauncherSettings(raw).ok).toBe(false);
  });
});
