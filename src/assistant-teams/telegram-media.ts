import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getProject } from '../store.js';
import { secretAccountVariable } from '../secrets.js';
import { telegramDownload, TELEGRAM_DOWNLOAD_MAX_BYTES, TELEGRAM_TOKEN_VARIABLE } from '../webhook-telegram.js';
import { isTelegramAudio, isTelegramSpeech, telegramAttachmentType } from '../assistant-telegram.js';
import { transcribeAudio, transcriptionEngine } from '../server/speech-to-text.js';
import { getTeam } from './store.js';
import { authorizeTeamTelegram } from './telegram.js';
import { teamTelegramConnection } from './telegram-store.js';
import { conversationDatabase, type StoredTeamMessage } from './conversations.js';
const active=new Map<string,Promise<StoredTeamMessage>>();
/** Durable descriptors are saved first. Pending consumers can call this again after restart. */
export async function prepareTeamMessageMedia(message:StoredTeamMessage):Promise<StoredTeamMessage>{
 const key=`${message.id}:${message.revision}`;const running=active.get(key);if(running)return running;
 const promise=prepare(message).finally(()=>active.delete(key));active.set(key,promise);return promise;
}
async function prepare(message:StoredTeamMessage):Promise<StoredTeamMessage>{
 if(!message.attachments.length)return message;
 await authorizeTeamTelegram(message.teamId,message.chatId,message.telegramUserId);
 const db=await conversationDatabase(), stored=db.prepare('SELECT record FROM assistant_team_message_versions WHERE message_id=? AND revision=?').get(message.id,message.revision) as {record:string}|undefined;
 if(stored)message=JSON.parse(stored.record) as StoredTeamMessage;
 const team=await getTeam(message.teamId),project=await getProject(team.projectId),known=await teamTelegramConnection(team.id);
 for(const [index,file] of message.attachments.entries()){
  if(file.path||file.problem)continue;
  if(index>=10){file.problem='Only the first 10 files can be read.';continue;}
  if(file.bytes!==null&&file.bytes>TELEGRAM_DOWNLOAD_MAX_BYTES){file.problem='File exceeds the 20 MB Telegram download limit.';continue;}
  const token=known&&secretAccountVariable([known.token_account_id],TELEGRAM_TOKEN_VARIABLE);
  if(!token||!project){file.problem='Media unavailable: reconnect the bot or restore its project.';continue;}
  try{
   const bytes=await telegramDownload(token,file.fileId);
   if(bytes.length>TELEGRAM_DOWNLOAD_MAX_BYTES){file.problem='File exceeds the 20 MB Telegram download limit.';continue;}
   const directory=path.join(project.path,'.joint-bob-attachments','team-telegram',message.id,String(message.revision));await mkdir(directory,{recursive:true});
   file.path=path.join(directory,`${index}-${file.name}`);await writeFile(file.path,bytes,{mode:0o600});
   file.detectedMimeType=telegramAttachmentType(bytes,file.mimeType);
   if(isTelegramSpeech(file)||isTelegramAudio(file)){
    if(transcriptionEngine(team.projectId)){
     try{file.extractedText=await transcribeAudio(team.projectId,bytes,file.name,file.mimeType) ?? undefined;}catch{file.problem='Audio transcription failed; original recording retained.';}
    }
    if(!file.extractedText&&!file.problem)file.problem='No transcription available; original recording retained.';
   }else if(file.mimeType.startsWith('text/'))file.extractedText=bytes.toString('utf8');
   else if(!file.mimeType.startsWith('image/'))file.problem='File retained; text extraction is not supported for this format.';
  }catch{file.problem='Media download or local storage failed.';}
 }
 const record=JSON.stringify(message);db.exec('BEGIN IMMEDIATE');try{
 db.prepare('UPDATE assistant_team_message_versions SET record=? WHERE message_id=? AND revision=?').run(record,message.id,message.revision);
 db.prepare("UPDATE assistant_team_messages SET record=? WHERE id=? AND json_extract(record,'$.revision')=?").run(record,message.id,message.revision);db.exec('COMMIT');
 }catch(error){db.exec('ROLLBACK');throw error;}
 return message;
}
