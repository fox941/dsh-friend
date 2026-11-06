import {WorkshopAutonomy} from './workshop-autonomy.js';
import {Workshop} from './workshop.js';
import {attachActivityConsoleHost} from './activity-console-host.js';
import {attachStickerLibraryHost} from './sticker-library-host.js';
import {attachSelfStateHost} from './self-state-host.js';
import {QQReplyIntegrity} from './qq-reply-integrity.js';
import {SocialExperience} from './social-experience.js';
import {attachSocialExperienceHost} from './social-experience-host.js';
import {ProfileChanges} from './profile-changes.js';
import {attachProfileChangesHost} from './profile-changes-host.js';
import {ProfileNotices} from './profile-notices.js';
import {attachProfileNoticesHost} from './profile-notices-host.js';
import {PersonProfiles} from './person-profiles.js';
import {ProfileSummary} from './profile-summary.js';
import {attachProfileSummaryHost} from './profile-summary-host.js';
import {attachPlatformsHost} from './platform-host.js';
import {Platforms} from './platforms.js';
import {registerRuntimeHealth,companionRuntimeHealth} from './runtime-health.js';
import path from 'node:path';
import { withMemoryStorageLock } from 'dsh-mnemon/extension-sdk';
import { policyReader } from './policy.js';
import { NativeClient } from './native-client.js';
import { CorrectionController } from './controller.js';
import { GrowthController } from './growth.js';
import { PreviewController } from './preview.js';
import { PreviewMemoryReader } from './preview-memory.js';
import * as runtimeContract from 'dsh-mnemon-source-runtime/contracts';
import {createRuntimeMemorySource} from 'dsh-mnemon-source-runtime';
import {RuntimeWriter} from './apply-runtime.js';
import {ApplyBackend} from './apply-backend.js';
import {ApplicationController} from './apply.js';
import {NightlyController} from './nightly.js';
import {attachNightlyHost} from './nightly-host.js';
import {ProtectionController} from './protection.js';
import {ConversationMemoryController} from './conversation-memory.js';
import {qqAuthority} from './qq.js';
import {readQQSettings} from './qq-config.js';
import {attachQQHost} from './qq-host.js';
import {validateAttention} from './attention-reviewer.js';
import {noSecret} from './validation.js';
import {attachAttentionHost} from './attention-host.js';
import {AttentionAffect} from './attention-affect.js';
import {Diagnostics} from './diagnostics.js';
import {attachDiagnosticsHost} from './diagnostics-host.js';
import {GoalController} from './goals.js';
import {ProactiveController} from './proactive.js';
import {reviewGrowth} from './growth-reviewer.js';
import {reviewEmotion} from './emotion-reviewer.js';
import {reviewStructured} from './structured-review.js';
import {ownerMessage,userEvidence} from './evidence.js';
import {ownerIdentity,originalOwnerEvent,registerBilibiliAuthority} from './source-identity.js';
import {eligibleHeader} from './preview-sessions.js';
import {goalNoSave} from './goals.js';
import {registerObservationAuthority,sealObservationSource} from './activity-source.js';
import {verifyReportSources} from './apply-evidence.js';
import {validateApplyPlan} from './apply-plan.js';
import {VideoGrounding} from './video-grounding.js';

export const name='ai-friend-companion-adapter';
export const provide=['friendAdapter'];
export const inject=['friendScheduler','friendQQBridge','friendBilibili'];
export async function apply(ctx,config={}) {
  if(!process.env.DSH_HOME)throw new Error('陪伴运行适配要求显式 DSH_HOME');
  const home=path.resolve(process.env.DSH_HOME),instance=path.dirname(home);
  const memoryDir=path.join(instance,'memory'),directory=path.join(instance,'companion');
  if(config.writeEnabled!==undefined&&typeof config.writeEnabled!=='boolean')throw new Error('writeEnabled 必须为布尔值');
  const channels=config.configuredChannels??['web'];
  if(!Array.isArray(channels)||channels.some(value=>!['web','qq','bilibili','douyin'].includes(value)))throw new Error('configuredChannels 只能包含已实际配置的受支持渠道');
  const policy=policyReader({home,memoryDir,writeEnabled:config.writeEnabled??true});
  const client=new NativeClient({memoryDir,policy});
  const controller=new CorrectionController({directory,client,policy,memoryDir,lock:withMemoryStorageLock});
  controller.growth=new GrowthController({journal:controller.journal,serial:(fn,signal)=>controller.serial(fn,signal),writeEnabled:()=>config.writeEnabled!==false,config:config.growth});
  const maintenanceAuthority=Object.freeze({}),conversationAuthority=Object.freeze({}),activityAuthority=Object.freeze({}),profileAuthority=Object.freeze({});
  const memoryReader=new PreviewMemoryReader({memoryDir,client,policy,runtimeContract,growth:controller.growth});
  controller.preview=new PreviewController({journal:controller.journal,workspace:path.join(instance,'workspace'),memoryReader,writeEnabled:()=>config.writeEnabled!==false,config:config.preview});
  const runtime=new RuntimeWriter({memoryDir,policy,createSource:createRuntimeMemorySource});
  const backend=new ApplyBackend({runtime,correction:controller,growth:controller.growth});
  controller.applications=new ApplicationController({journal:controller.journal,preview:controller.preview,backend,memoryReader,growth:controller.growth,policy,workspace:path.join(instance,'workspace'),writeEnabled:()=>config.writeEnabled!==false,config:config.application,maintenanceAuthority,conversationAuthority,activityAuthority,profileAuthority});
  controller.protection=new ProtectionController({journal:controller.journal,applications:controller.applications,backend,memoryDir,directory,config:config.protection});
  controller.applications.protection=controller.protection;
  controller.conversations=new ConversationMemoryController({applications:controller.applications,backend,memoryReader,workspace:path.join(instance,'workspace'),authority:conversationAuthority,config:config.conversationMemory});
  const nightlyPreview=new PreviewController({journal:controller.journal,workspace:path.join(instance,'workspace'),memoryReader,writeEnabled:()=>config.writeEnabled!==false,config:config.preview,namespace:'nightly',maintenanceAuthority});
  controller.nightly=new NightlyController({journal:controller.journal,preview:nightlyPreview,applications:controller.applications,manualPreview:controller.preview,growth:controller.growth,policy,authority:maintenanceAuthority,config:config.nightly});
  controller.preview.applicationInfo=id=>controller.applications.reportInfo(id);
  nightlyPreview.applicationInfo=id=>controller.applications.reportInfo(id);
  controller.growth.pendingReviewKeys=()=>controller.applications.pendingStateKeys();
  controller.configuredChannels=[...new Set(channels)];
  let qqSettings,qqIssue=null;
  try{qqSettings=await readQQSettings(instance);}catch{qqSettings={enabled:false,configured:false};qqIssue='QQ本地配置未通过校验，通道保持关闭；网页聊天不受影响';}
  controller.personProfiles=new PersonProfiles(controller);
  controller.qqBridge=ctx.friendQQBridge;
  controller.qq=ctx.friendQQBridge.createChannel({journal:controller.journal,workspace:path.join(instance,'workspace'),settings:qqSettings,authority:qqAuthority,reliability:config.qqReliability});
  if(qqIssue)controller.qq.lastError=qqIssue;
  if(qqSettings.configured&&!controller.configuredChannels.includes('qq'))controller.configuredChannels.push('qq');
  // B站功能在独立插件内装配；宿主经端口注入共享基础设施，经 host 访问器暴露运行状态。
  controller.bilibili=await ctx.friendBilibili.create({
    journal:controller.journal,workspace:path.join(instance,'workspace'),instance,
    config:{activities:{...config.activities,...config.writeEnabled===false?{enabled:false}:{}},video:config.video,bilibiliInbox:config.bilibiliInbox,bilibiliSocial:config.bilibiliSocial,accountActions:config.accountActions},
    writeEnabled:()=>config.writeEnabled!==false,
    authority:activityAuthority,
    growth:controller.growth,applications:controller.applications,memoryReader,
    native:client,
    host:()=>controller,
    ports:{
      people:{context:(turnId,signal)=>controller.personProfiles.forBilibili(turnId,signal),normalize:(...args)=>controller.personProfiles.normalize(...args)},
      evidence:{ownerMessage,userEvidence},
      identity:{ownerIdentity,originalOwnerEvent,registerBilibiliAuthority},
      eligibleHeader,goalNoSave,reviewStructured,review:{reviewStructured},
      reviewers:{growth:reviewGrowth,emotion:reviewEmotion},
      observationSource:{registerObservationAuthority,sealObservationSource},
      memory:{verifyReportSources,validateApplyPlan},
    },
  });
  controller.activities=controller.bilibili.activities;
  controller.videoGrounding=new VideoGrounding({journal:controller.journal,workspace:path.join(instance,'workspace'),activities:controller.activities});
  controller.preview.videoGrounding=controller.videoGrounding;nightlyPreview.videoGrounding=controller.videoGrounding;controller.applications.videoGrounding=controller.videoGrounding;
  controller.bilibiliInbox=controller.bilibili.bilibiliInbox;
  controller.bilibiliSocial=controller.bilibili.bilibiliSocial;
  controller.accountActions=controller.bilibili.accountActions;
  controller.activityRequests=controller.bilibili.activityRequests;
  controller.attentionCapabilities=[controller.bilibili.capability];
  controller.workspace=path.join(instance,'workspace');
  if(process.env.AI_FRIEND_INSTANCE!=='test'){controller.workshop=new Workshop({instance,enabled:()=>config.writeEnabled!==false&&config.workshop?.enabled!==false,validate:noSecret});await controller.workshop.ready;}
  controller.diagnostics=new Diagnostics({journal:controller.journal,config:config.diagnostics});
  controller.attention=ctx.friendScheduler.create({validateDecision:validateAttention,validateData:noSecret,journal:controller.journal,config:config.attention,diagnostics:controller.diagnostics});
  controller.bilibili.attention=controller.attention;
  controller.attentionAffect=new AttentionAffect({attention:controller.attention,growth:controller.growth});
  if(controller.workshop){controller.workshopAutonomy=new WorkshopAutonomy(controller,{config:config.workshopAutonomy});controller.attentionCapabilities.push(controller.workshopAutonomy.capability());}
  controller.goals=new GoalController({journal:controller.journal,attention:controller.attention,activities:controller.activities,writeEnabled:()=>config.writeEnabled!==false,config:config.goals});
  controller.bilibiliSocial.goals=controller.goals;
  controller.proactive=new ProactiveController(controller,{config:config.proactive,writeEnabled:()=>config.writeEnabled!==false});
  for(const service of [controller.qq,controller.activities,controller.nightly,controller.bilibiliSocial])service.attention=controller.attention;
  if(controller.protection.hasPendingUndo()){await controller.bilibili.close();await controller.qq.close();await controller.growth.close();await controller.close();throw new Error('存在未完成的停机撤销，请先用原批次继续恢复');}
  await controller.recover(3);
  ctx.provide('friendAdapter',controller);
  const removeHealth=registerRuntimeHealth(instance,()=>companionRuntimeHealth(controller));
  ctx.effect(()=>removeHealth,'ai-friend: passive health provider');
  attachDiagnosticsHost(ctx,controller);
  controller.writeEnabled=config.writeEnabled!==false;controller.platforms=new Platforms(controller,{config:{...config.platforms,...process.env.AI_FRIEND_INSTANCE==='test'?{enabled:false}:{} }});controller.qqReplyIntegrity=new QQReplyIntegrity(controller);controller.qq.platforms=controller.platforms;controller.qq.media=controller.platforms.media;controller.platforms.reconcile();
  controller.platforms.setBiliOperations(controller.bilibili.platformOperations());
  controller.profileSummary=new ProfileSummary(controller,{authority:profileAuthority});
  controller.profileChanges=new ProfileChanges(controller,{authority:profileAuthority});
  controller.socialExperience=new SocialExperience(controller);controller.attentionCapabilities.push(controller.socialExperience.capability());attachSocialExperienceHost(ctx,controller);
  controller.profileNotices=new ProfileNotices(controller);
  controller.attentionCapabilities.push(controller.profileNotices.capability());
  attachProfileNoticesHost(ctx,controller);
  attachProfileChangesHost(ctx,controller);
  attachProfileSummaryHost(ctx,controller);
  attachSelfStateHost(ctx,controller);
  attachActivityConsoleHost(ctx,controller);
  attachStickerLibraryHost(ctx,controller);
  controller.qq.activityRequests=controller.activityRequests;
  attachPlatformsHost(ctx,controller);
  attachAttentionHost(ctx,controller);
  attachNightlyHost(ctx,controller);
  attachQQHost(ctx,controller);
  ctx.effect(()=>async()=>{await controller.workshopAutonomy?.close();await controller.workshop?.close();await controller.socialExperience.close();await controller.profileNotices.close();await controller.profileChanges.close();await controller.profileSummary.close();await controller.attention.close();await controller.platforms.close();await controller.bilibili.close();await controller.qq.close();await controller.nightly.close();await Promise.allSettled([controller.applications.close(),controller.preview.close(),controller.growth.close()]);controller.diagnostics.close();await controller.close();},'ai-friend: state, preview and correction journal');
}
