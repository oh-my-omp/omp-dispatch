import {expect,test} from 'bun:test';
import {readdirSync,readFileSync} from 'node:fs';
import {parseAgenda,parseSeatToolParameters,parseToolParameters} from '../src/domain/parse.ts';
import type {Action,PortInput,Result,ParseError,ToolParameters} from '../src/domain/model.ts';

const repo={owner:'oh-my-omp',name:'omp-dispatch'},other={owner:'oh-my-omp',name:'omp-config'};
const issue={repo,number:236},otherIssue={repo,number:237},parent={repo,number:290},target={repo,base:'main'};
const sha='1'.repeat(40),hash='a'.repeat(64),agenda='9c825bdb-049d-4098-8836-0559bfd96760';

function required(result:Result<ToolParameters,ParseError>):PortInput {
  if(!result.ok)throw new Error(`${result.error.path}: ${result.error.reason}`);
  return result.value.input;
}

test('Main operations map the new wire shape back onto the original port input',()=>{
  expect(required(parseToolParameters({input:{op:'convene',parent:'oh-my-omp/omp-dispatch#290',tickets:[
    {id:'A',issue:'oh-my-omp/omp-dispatch#236',target:'oh-my-omp/omp-dispatch@main',dependsOn:['B'],adoptPr:'oh-my-omp/omp-dispatch#300'},
    {id:'B',issue:'oh-my-omp/omp-dispatch#237',target:'oh-my-omp/omp-dispatch@main',dependsOn:[]},
  ]}}))).toEqual({op:'convene',parent,tickets:[
    {id:'A',issue,target,dependsOn:['B'],adoptPr:{repo,number:300}},
    {id:'B',issue:otherIssue,target,dependsOn:[],adoptPr:null},
  ]});
  expect(required(parseToolParameters({input:{op:'convene',tickets:[{id:'A',issue:'oh-my-omp/omp-dispatch#236',target:'oh-my-omp/omp-dispatch@main',dependsOn:[]}]}})))
    .toEqual({op:'convene',parent:null,tickets:[{id:'A',issue,target,dependsOn:[],adoptPr:null}]});
  expect(required(parseToolParameters({input:{op:'resume',agenda}}))).toEqual({op:'resume',agenda});
  expect(required(parseToolParameters({input:{op:'tickets'}}))).toEqual({op:'tickets'});
  expect(required(parseToolParameters({input:{op:'status'}}))).toEqual({op:'status'});
  expect(required(parseToolParameters({input:{op:'read',ticketId:'A'}}))).toEqual({op:'read',ticketId:'A'});
  expect(required(parseToolParameters({input:{op:'launch',ticketId:'A',role:'review'}}))).toEqual({op:'launch',ticketId:'A',role:'review'});
  expect(required(parseToolParameters({input:{op:'finish',summary:'Delivered.'}}))).toEqual({op:'finish',summary:'Delivered.'});
});

test('resolve maps every flattened action and the three-state adopted pull request',()=>{
  const actions:Action[]=[
    {kind:'publishPr',issue,headRepo:repo,branch:'feature',head:sha,target,pr:null,expectedBodyHash:null,title:'Publish',body:'Body'},
    {kind:'merge',issue,pr:{repo,number:300},head:sha,target,stampHash:hash},
    {kind:'setIssueState',issue,open:false,bodyHash:hash,afterEvent:null},
    {kind:'replaceBody',issue,expectedHash:hash,body:'New body'},
    {kind:'createIssue',repo:other,title:'New issue',body:'Issue body'},
    {kind:'attachChild',parent:issue,child:otherIssue},
    {kind:'rerunChecks',pr:{repo,number:300},repo,workflowRunId:7,previousAttempt:2,head:sha},
    {kind:'comment',issue,body:'Comment body\n\n<!-- marker -->',marker:{kind:'impl',key:'key'}},
    {kind:'setProjectField',issue,field:'status',option:'Done'},
    {kind:'requestAnswer',issue,comment:12,question:'Which one?',tier:'complex'},
  ];
  const resolved=required(parseToolParameters({input:{op:'resolve',ticketId:'A',revision:3,ruling:'Ruling.',to:'Coding',
    dependsOn:['B'],target:'oh-my-omp/omp-dispatch@main',adoptPr:'oh-my-omp/omp-dispatch#300',noCode:'No code needed.',
    add:[{id:'C',issue:'oh-my-omp/omp-dispatch#238',target:'oh-my-omp/omp-dispatch@main',dependsOn:[]}],remove:['D'],
    effects:[{effectId:'run/publishPr/1',disposition:'retry'}],
    actions:[
      {kind:'publishPr',issue:'oh-my-omp/omp-dispatch#236',headRepo:'oh-my-omp/omp-dispatch',branch:'feature',head:sha,target:'oh-my-omp/omp-dispatch@main',title:'Publish',body:'Body'},
      {kind:'merge',issue:'oh-my-omp/omp-dispatch#236',pr:'oh-my-omp/omp-dispatch#300',head:sha,target:'oh-my-omp/omp-dispatch@main',stampHash:hash},
      {kind:'setIssueState',issue:'oh-my-omp/omp-dispatch#236',open:false,bodyHash:hash},
      {kind:'replaceBody',issue:'oh-my-omp/omp-dispatch#236',expectedHash:hash,body:'New body'},
      {kind:'createIssue',repo:'oh-my-omp/omp-config',title:'New issue',body:'Issue body'},
      {kind:'attachChild',parent:'oh-my-omp/omp-dispatch#236',child:'oh-my-omp/omp-dispatch#237'},
      {kind:'rerunChecks',pr:'oh-my-omp/omp-dispatch#300',repo:'oh-my-omp/omp-dispatch',workflowRunId:7,previousAttempt:2,head:sha},
      {kind:'comment',issue:'oh-my-omp/omp-dispatch#236',body:'Comment body\n\n<!-- marker -->',markerKind:'impl',markerKey:'key'},
      {kind:'setProjectField',issue:'oh-my-omp/omp-dispatch#236',field:'status',option:'Done'},
      {kind:'requestAnswer',issue:'oh-my-omp/omp-dispatch#236',comment:12,question:'Which one?',tier:'complex'},
    ]}}));
  expect(resolved).toEqual({op:'resolve',ticketId:'A',revision:3,ruling:'Ruling.',to:'Coding',dependsOn:['B'],target,
    adoptPr:{repo,number:300},noCode:'No code needed.',
    add:[{id:'C',issue:{repo,number:238},target,dependsOn:[],adoptPr:null}],remove:['D'],
    effects:[{effectId:'run/publishPr/1',disposition:'retry'}],actions});
  const cleared=required(parseToolParameters({input:{op:'resolve',ticketId:'A',revision:3,ruling:'Clear.',to:'Coding',clearAdoptPr:true}}));
  expect(cleared).toEqual({op:'resolve',ticketId:'A',revision:3,ruling:'Clear.',to:'Coding',adoptPr:null});
  const untouched=required(parseToolParameters({input:{op:'resolve',ticketId:'A',revision:3,ruling:'Keep.',to:'Coding'}}));
  expect('adoptPr' in untouched).toBe(false);
});

test('seat operations map the new wire shape back onto the original port input',()=>{
  expect(required(parseSeatToolParameters({input:{op:'read',ticketId:'A'}}))).toEqual({op:'read',ticketId:'A'});
  expect(required(parseSeatToolParameters({input:{op:'submit',ticketId:'A',revision:2,branch:'feature',head:sha,title:'Deliver',body:'Closes oh-my-omp/omp-dispatch#236'}})))
    .toEqual({op:'submit',ticketId:'A',revision:2,branch:'feature',head:sha,title:'Deliver',body:'Closes oh-my-omp/omp-dispatch#236'});
  expect(required(parseSeatToolParameters({input:{op:'verdict',ticketId:'A',revision:2,role:'review',ok:true,note:'Verified the head.'}})))
    .toEqual({op:'verdict',ticketId:'A',revision:2,role:'review',ok:true,note:'Verified the head.'});
  expect(required(parseSeatToolParameters({input:{op:'escalate',ticketId:'A',revision:2,kind:'question',reason:'Which one?',tier:'complex'}})))
    .toEqual({op:'escalate',ticketId:'A',revision:2,kind:'question',reason:'Which one?',tier:'complex'});
  for(const kind of ['blocked','split','noCode'] as const)
    expect(required(parseSeatToolParameters({input:{op:'escalate',ticketId:'A',revision:2,kind,reason:`${kind} reason`}})))
      .toEqual({op:'escalate',ticketId:'A',revision:2,kind,reason:`${kind} reason`});
});

test('each Main operation refuses a field that belongs to another operation',()=>{
  const cases:Record<string,Record<string,unknown>>={
    convene:{ticketId:'A'},resume:{ticketId:'A'},tickets:{ticketId:'A'},status:{agenda},
    read:{revision:1},launch:{revision:1},resolve:{branch:'feature'},finish:{ticketId:'A'},
  };
  for(const [op,field] of Object.entries(cases)){
    const result=parseToolParameters({input:{op,...field}});
    expect({op,...field,ok:result.ok}).toMatchObject({ok:false});
  }
});

test('each seat operation refuses a field that belongs to another operation',()=>{
  const cases:Record<string,Record<string,unknown>>={
    read:{revision:1},submit:{note:'A note'},verdict:{branch:'feature'},escalate:{body:'A body'},
  };
  for(const [op,field] of Object.entries(cases)){
    const result=parseSeatToolParameters({input:{op,...field}});
    expect({op,...field,ok:result.ok}).toMatchObject({ok:false});
  }
});

test('each caller refuses the other caller operations',()=>{
  expect(parseSeatToolParameters({input:{op:'resolve',ticketId:'A',revision:1,ruling:'Ruling.',to:'Coding'}}).ok).toBe(false);
  expect(parseToolParameters({input:{op:'submit',ticketId:'A',revision:1,branch:'feature',head:sha,title:'Deliver',body:'Closes oh-my-omp/omp-dispatch#236'}}).ok).toBe(false);
  expect(parseSeatToolParameters({input:{op:'read',ticketId:'A',summary:'Not a seat operation'}}).ok).toBe(false);
});

test('each action refuses a field that belongs to another action kind',()=>{
  expect(parseToolParameters({input:{op:'resolve',ticketId:'A',revision:3,ruling:'Ruling.',to:'Coding',
    actions:[{kind:'merge',issue:'oh-my-omp/omp-dispatch#236',pr:'oh-my-omp/omp-dispatch#300',head:sha,target:'oh-my-omp/omp-dispatch@main',stampHash:hash,title:'Not a merge field'}]}}).ok).toBe(false);
  expect(parseToolParameters({input:{op:'resolve',ticketId:'A',revision:3,ruling:'Ruling.',to:'Coding',
    actions:[{kind:'createIssue',repo:'oh-my-omp/omp-config',title:'New issue',body:'Body',issue:'oh-my-omp/omp-dispatch#236'}]}}).ok).toBe(false);
});

test('reference strings and required fields are refused by name',()=>{
  const cases:[Record<string,unknown>,string][]=[
    [{op:'convene',tickets:[{id:'A',issue:'not a reference',target:'oh-my-omp/omp-dispatch@main',dependsOn:[]}]},'tickets.0.issue'],
    [{op:'convene',tickets:[{id:'A',issue:'oh-my-omp/omp-dispatch#236',target:'oh-my-omp/omp-dispatch',dependsOn:[]}]},'tickets.0.target'],
    [{op:'resolve',ticketId:'A',revision:3,ruling:'Ruling.',to:'Coding',actions:[{kind:'createIssue',repo:'bad',title:'T',body:'B'}]},'actions.0.repo'],
    [{op:'resolve',ticketId:'A',revision:3,ruling:'Ruling.',to:'Coding',actions:[{kind:'publishPr',issue:'oh-my-omp/omp-dispatch#236',target:'oh-my-omp/omp-dispatch@main'}]},'actions.0.headRepo'],
  ];
  for(const [input,path] of cases){
    const result=parseToolParameters({input});
    expect(result.ok).toBe(false);
    if(!result.ok)expect(result.error.path).toBe(path);
  }
  const missing=parseToolParameters({input:{op:'submit',ticketId:'A'}});
  expect(missing.ok).toBe(false);
  expect(parseSeatToolParameters({input:{op:'submit',ticketId:'A'}}).ok).toBe(false);
});

test('the stored agenda formats still parse',()=>{
  const fixtures=new URL('../tests/sim/fixtures/',import.meta.url);
  const names=readdirSync(fixtures).filter(name=>name.endsWith('.json'));
  expect(names.length).toBeGreaterThan(0);
  for(const name of names){
    const envelope=JSON.parse(readFileSync(new URL(name,fixtures),'utf8')) as {format:number;state:unknown};
    const parsed=parseAgenda(envelope.state);
    if(!parsed.ok)throw new Error(`${name}: ${parsed.error.path}: ${parsed.error.reason}`);
    expect(parsed.value.id).toBe(name.replace(/\.json$/,''));
  }
});
