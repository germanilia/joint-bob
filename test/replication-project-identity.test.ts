import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import test from "node:test";
import {getClusterNode} from "../src/cluster.js";
import {receiveReplicationBatch,type ReplicationEvent} from "../src/replication.js";
import {applyQueuedPromptEvent,ensurePromptQueueSchema} from "../src/prompt-queue.js";

test("a conversation record cannot rebind a private runtime identity to a shared project",async()=>{
 await getClusterNode();const origin=randomUUID(),sessionId=randomUUID(),now=new Date().toISOString();
 const event=(projectId:string):ReplicationEvent=>{
  const record={projectId,engine:'pi',sessionId,createdAt:now,updatedAt:now,originNodeId:origin};
  return {id:randomUUID(),originNodeId:origin,entityType:'conversation.record',entityKey:`${projectId}:pi:${sessionId}`,operation:'upsert',createdAt:now,payload:{...record,record}};
 };
 await receiveReplicationBatch({events:[event('private-project')]});
 await assert.rejects(receiveReplicationBatch({events:[event('shared-project')]}),/Conversation identity belongs to a different project/);
});

test("a queue deletion cannot remove another project's prompt using its global id",()=>{
 const db=new DatabaseSync(":memory:");ensurePromptQueueSchema(db);
 try{
  const id=randomUUID(),now=new Date().toISOString();
  db.prepare("INSERT INTO queued_prompt_tombstones VALUES(?,?)").run(id,"private-project:conversation");
  const event:ReplicationEvent={id:randomUUID(),originNodeId:randomUUID(),entityType:"conversation.queue",entityKey:id,operation:"delete",createdAt:now,payload:{projectId:"shared-project",conversationId:"conversation",id,prompt:null,revision:1,sequence:1,createdAt:now}};
  assert.throws(()=>applyQueuedPromptEvent(db,event),/Prompt identity belongs to a different project/);
 }finally{db.close();}
});
