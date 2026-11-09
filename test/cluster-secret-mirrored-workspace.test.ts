import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {api,pairTwinNodes,seedDevEnvironment,signIn,startDevNode,stopDevNode} from './dev-nodes.js';

async function eventually(check:()=>Promise<void>) {
 const until=Date.now()+30000;
 for(;;){try{await check();return;}catch(error){if(Date.now()>until)throw error;await new Promise(resolve=>setTimeout(resolve,250));}}
}

test('a twin workspace secret does not block a separately granted account from reaching a third node', {timeout:120000}, async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'secret-twin-workspace-'));
 const children:Awaited<ReturnType<typeof startDevNode>>[]=[];
 try{
  const twins=await seedDevEnvironment(path.join(root,'twins'),2),third=await seedDevEnvironment(path.join(root,'third'),1);
  const [owner,sharer]=twins.nodes,recipient=third.nodes[0];
  children.push(await startDevNode(twins,owner),await startDevNode(twins,sharer),await startDevNode(third,recipient));
  const so=await signIn(twins,owner),ss=await signIn(twins,sharer),sr=await signIn(third,recipient);
  await pairTwinNodes(twins);
  const cluster=await api<{snapshot:{body:{clusterId:string}}}>(owner,so,'POST','/clusters',{name:'Twin workspace credentials'});
  const id=cluster.body.snapshot.body.clusterId;
  for(const [node,session] of [[sharer,ss],[recipient,sr]] as const){
   const invite=await api<{link:string}>(owner,so,'POST',`/clusters/${id}/invitations`,{expectedEpoch:1});
   assert.equal((await api(node,session,'POST','/clusters/join',{link:invite.body.link,requestId:randomUUID()})).status,201);
  }
  const projects=await api<{projects:Array<{id:string;type:string}>}>(owner,so,'GET','/projects');
  const project=projects.body.projects.find(p=>p.id===owner.projects[0].id)!;
  assert.equal((await api(owner,so,'PUT',`/clusters/${id}/sharing`,{projectIds:[],workspaceIds:[project.type],confirmOwnedData:true})).status,200);
  await eventually(async()=>{
   const listed=await api<{projects:Array<{id:string;type:string}>}>(recipient,sr,'GET','/projects');
   assert.ok(listed.body.projects.some(p=>p.id===project.id),'recipient has the owner workspace project');
  });
  const inherited=await api<{account:{id:string}}>(sharer,ss,'POST','/secrets/accounts',{label:'Twin workspace secret',provider:'custom',replicate:true,variables:[{name:'WORKSPACE_KEY',kind:'value',value:'synthetic-workspace'}]});
  assert.equal(inherited.status,201);
  assert.equal((await api(sharer,ss,'PUT',`/secrets/scopes/workspace/${project.type}`,{accountIds:[inherited.body.account.id]})).status,200);
  const granted=await api<{account:{id:string}}>(sharer,ss,'POST','/secrets/accounts',{label:'Standalone Jev',provider:'typesafe',variables:[{name:'TYPESAFE_AI_API_KEY',kind:'value',value:'synthetic-jev'}]});
  assert.equal(granted.status,201);
  assert.equal((await api(sharer,ss,'PUT',`/secrets/accounts/${granted.body.account.id}/sharing`,{grants:[{clusterId:id,nodeId:recipient.nodeId}]})).status,200);
  await eventually(async()=>{
   const secrets=await api<{accounts:Array<{id:string;readOnly?:boolean}>}>(recipient,sr,'GET','/secrets');
   assert.equal(secrets.body.accounts.find(a=>a.id===granted.body.account.id)?.readOnly,true,'workspace scope must not poison the separately granted account delivery');
   const assigned=await api<{accountIds:string[]}>(recipient,sr,'GET',`/secrets/scopes/project/${project.id}`);
   assert.ok(assigned.body.accountIds.includes(inherited.body.account.id),'twin workspace attachment arrives on its authorized project');
  });
 }finally{await Promise.all(children.map(stopDevNode));await rm(root,{recursive:true,force:true});}
});

test('a secret attached to a workspace mirrored from the recipient reaches the recipient', {timeout:90000}, async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'secret-mirrored-'));
 const children:Awaited<ReturnType<typeof startDevNode>>[]=[];
 try{
  const a=await seedDevEnvironment(path.join(root,'a'),1),b=await seedDevEnvironment(path.join(root,'b'),1);
  const sharer=a.nodes[0],owner=b.nodes[0];
  children.push(await startDevNode(a,sharer),await startDevNode(b,owner));
  const sa=await signIn(a,sharer),sb=await signIn(b,owner);
  const cluster=await api<{snapshot:{body:{clusterId:string}}}>(sharer,sa,'POST','/clusters',{name:'Mirrored workspace'});
  const id=cluster.body.snapshot.body.clusterId;
  const invite=await api<{link:string}>(sharer,sa,'POST',`/clusters/${id}/invitations`,{expectedEpoch:1});
  assert.equal((await api(owner,sb,'POST','/clusters/join',{link:invite.body.link,requestId:randomUUID()})).status,201);
  const selection=await api<{workspaces:Array<{id:string}>}>(owner,sb,'GET',`/clusters/${id}/sharing`);
  const ownWorkspace=selection.body.workspaces[0].id;
  assert.equal((await api(owner,sb,'PUT',`/clusters/${id}/sharing`,{projectIds:[],workspaceIds:[ownWorkspace],confirmOwnedData:true})).status,200);
  let mirrored='',projectId='';
  await eventually(async()=>{
   const projects=await api<{projects:Array<{id:string;type:string}>}>(sharer,sa,'GET','/projects');
   const project=projects.body.projects.find(item=>owner.projects.some(own=>own.id===item.id));
   assert.ok(project,'owner project metadata arrives');
   assert.notEqual(project.type,ownWorkspace,'the sharer sees a local mirror id, not the owner workspace id');
   mirrored=project.type;projectId=project.id;
  });
  const created=await api<{account:{id:string}}>(sharer,sa,'POST','/secrets/accounts',{label:'Stripe dev',provider:'stripe',variables:[{name:'STRIPE_API_KEY',kind:'value',value:'synthetic-stripe'}]});
  const accountId=created.body.account.id;
  assert.equal((await api(sharer,sa,'PUT',`/secrets/scopes/workspace/${mirrored}`,{accountIds:[accountId]})).status,200);
  assert.equal((await api(sharer,sa,'PUT',`/secrets/accounts/${accountId}/sharing`,{grants:[{clusterId:id,nodeId:owner.nodeId}]})).status,200);
  assert.equal((await api(sharer,sa,'PUT',`/clusters/${id}/secrets`,{accountIds:[accountId]})).status,200);
  const grants=await api<{grants:Array<{clusterId:string;nodeId:string|null}>}>(sharer,sa,'GET',`/secrets/accounts/${accountId}/sharing`);
  assert.equal(grants.body.grants.length,2,'cluster sharing keeps the existing node grant');
  const inventory=await api<{granted:string[]}>(sharer,sa,'GET',`/clusters/${id}/secrets`);
  assert.deepEqual(inventory.body.granted,[accountId]);
  await eventually(async()=>{
   const secrets=await api<{accounts:Array<{id:string;readOnly?:boolean}>}>(owner,sb,'GET','/secrets');
   assert.equal(secrets.body.accounts.find(item=>item.id===accountId)?.readOnly,true);
   const assigned=await api<{accountIds:string[]}>(owner,sb,'GET',`/secrets/scopes/project/${projectId}`);
   assert.ok(assigned.body.accountIds.includes(accountId),'the owner project receives the attachment');
  });
  assert.equal((await api(sharer,sa,'PUT',`/clusters/${id}/secrets`,{accountIds:[]})).status,200);
  const remaining=await api<{grants:Array<{clusterId:string;nodeId:string|null}>}>(sharer,sa,'GET',`/secrets/accounts/${accountId}/sharing`);
  assert.deepEqual(remaining.body.grants,[{clusterId:id,nodeId:owner.nodeId}],'unticking the cluster leaves the node grant');
 }finally{await Promise.all(children.map(stopDevNode));await rm(root,{recursive:true,force:true});}
});
