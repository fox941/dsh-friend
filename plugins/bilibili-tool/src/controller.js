import {ActivitySettings} from './activity-settings.js';
import {BilibiliAccountActions} from './bilibili-account.js';
import {ActivityController} from './activities.js';
import {BilibiliClient} from './bilibili-client.js';
import {VideoMedia} from './video-media.js';
import {VideoObserver} from './video-observer.js';
import {BilibiliInboxController} from './bilibili-inbox.js';
import {BilibiliInboxClient} from './bilibili-inbox-client.js';
import {BilibiliSocialController} from './bilibili-social.js';
import {BilibiliSocialClient} from './bilibili-social-client.js';
import {readSocialSettings} from './bilibili-social-settings.js';
import {ActivityRequests} from './activity-requests.js';
import {bilibiliAttentionCapability} from './attention-capability.js';
import {bilibiliPerceptionSource} from './perception-source.js';
import {BiliPlatformOperations} from './platform-operations.js';

/**
 * Assembled by the host (companion-adapter) via the friendBilibili service.
 * context: {journal, workspace, instance, config, writeEnabled, authority, growth,
 *           applications, memoryReader, native, host, ports}
 * `host` is a late-bound accessor to the host controller (qq, proactive, platforms,
 * attention, goals), `ports` inject host-owned behaviour (evidence, identity,
 * reviewers, memory pipeline, observation-source sealing).
 */
export class BilibiliToolController{
 constructor(context){Object.assign(this,{...context,client:context.native});this.host=context.host??(function(){return null;});this.closed=false;}
 static async create(context){
  const {journal,workspace,instance,config={},writeEnabled=()=>true,authority,growth,applications,memoryReader,native,host=()=>null,ports={}}=context;
  const controller=new BilibiliToolController({journal,workspace,instance,config,writeEnabled,authority,growth,applications,memoryReader,native,host,ports});
  controller.activities=new ActivityController({journal,workspace,instance,growth,applications,memoryReader,client:new BilibiliClient(instance),authority,config:config.activities,ports});
  controller.activities.video=new VideoObserver({journal,media:new VideoMedia(instance),config:config.video});
  controller.bilibiliInbox=new BilibiliInboxController({journal,workspace,instance,client:new BilibiliInboxClient(instance),config:config.bilibiliInbox,ports});
  controller.bilibiliSocial=new BilibiliSocialController({inbox:controller.bilibiliInbox,workspace,client:new BilibiliSocialClient(instance),config:{...config.bilibiliSocial,...await readSocialSettings(instance)},growth,applications,authority,native,memoryReader,ports});
  controller.bilibiliInbox.social=controller.bilibiliSocial;
  controller.activities.store.socialVerifier=source=>controller.bilibiliSocial.store.verify(source);
  controller.activityRequests=new ActivityRequests(controller);
  controller.accountActions=new BilibiliAccountActions(controller,{config:config.accountActions,writeEnabled});
  controller.activities.accountActions=controller.accountActions;
  controller.activitySettings=new ActivitySettings(controller);
  controller.capability=bilibiliAttentionCapability(controller);
  controller.perceptionSource=(row,record)=>bilibiliPerceptionSource(controller,row,record);
  controller.platformOperations=()=>controller._platformOperations??(controller._platformOperations=new BiliPlatformOperations({instance}));
  return controller;
 }
 async close(){if(this.closing)return this.closing;this.closing=(async()=>{await this.accountActions?.close();await this.bilibiliSocial?.close();await this.bilibiliInbox?.close();await this.activities?.close();})().finally(()=>{this.closed=true;});return this.closing;}
 status(){return {closed:this.closed,activities:this.activities?this.activities.status():null,inbox:this.bilibiliInbox?this.bilibiliInbox.status():null,social:this.bilibiliSocial?this.bilibiliSocial.status():null,accountActions:this.accountActions?this.accountActions.status():null,requests:this.activityRequests?this.activityRequests.status():null};}
}
