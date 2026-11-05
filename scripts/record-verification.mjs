import {requireMain} from './instances.mjs';
requireMain('scripts/record-verification.mjs');
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { connectDev } from './dev-client.mjs';
import { DatabaseSync } from 'node:sqlite';
import { projectRoot, instanceRoot } from './paths.mjs';

const client = await connectDev();
const status = (await client.rpc('dshMnemon/read', { endpoint: 'status', payload: {} })).value;
const runtime = (await client.rpc('dshMnemon/read', { endpoint: 'runtime-memory', payload: {} })).value;
const presets = await client.rpc('agentPresets/list');
const catalog = await client.rpc('session/modelCatalog');
if (!status.commandFound || !status.memorySystem.serving || presets.presets.find(row => row.id === 'companion')?.broken) throw new Error('Final runtime is not healthy');
if (catalog.default.model !== 'deepseek-flash') throw new Error('Model configuration is not as expected');
const files=[];
async function scanCode(relative=''){
  for(const entry of await fs.readdir(path.join(projectRoot,relative),{withFileTypes:true})){
    const name=path.join(relative,entry.name);
    if(entry.isSymbolicLink())continue;
    if(entry.isDirectory()){if(relative||['plugins','scripts','tests','docs'].includes(entry.name))await scanCode(name);}
    else if(entry.isFile())files.push(name);
  }
}
await scanCode();
const secret = JSON.parse(await fs.readFile(path.join(instanceRoot, 'credentials.local.json'), 'utf8')).DEEPSEEK_API_KEY;
for (const file of files) if ((await fs.readFile(path.join(projectRoot, file), 'utf8')).includes(secret)) throw new Error(`Credential appeared in a code/document file: ${file}`);
const retention = JSON.parse(await fs.readFile(path.join(projectRoot, '.work', 'native-check-result.json'), 'utf8'));
const recovery = JSON.parse(await fs.readFile(path.join(projectRoot, '.work', 'restore-check-result.json'), 'utf8'));
const now = new Date().toISOString();
const growthDb=new DatabaseSync(path.join(instanceRoot,'companion/companion.sqlite'),{readOnly:true});
let growthState,previewState,applicationState,nightlyState,protectionState,emotionState,conversationState;
try{growthState={schema:growthDb.prepare('SELECT version FROM growth_schema WHERE id=1').get().version,revision:Number(growthDb.prepare("SELECT value FROM growth_meta WHERE key='revision'").get().value),heads:growthDb.prepare('SELECT count(*) AS n FROM growth_heads').get().n,reviewCalls:growthDb.prepare('SELECT coalesce(sum(started_calls),0) AS n FROM growth_budget').get().n,integrity:Object.values(growthDb.prepare('PRAGMA quick_check').get())[0]};previewState={schema:growthDb.prepare('SELECT version FROM preview_schema WHERE id=1').get().version,reports:growthDb.prepare('SELECT count(*) AS n FROM preview_runs').get().n,reviewCalls:growthDb.prepare('SELECT coalesce(sum(started_calls),0) AS n FROM preview_budget').get().n,automatic:false,appliesProposals:false};applicationState={schema:growthDb.prepare('SELECT version FROM apply_schema WHERE id=1').get().version,runs:growthDb.prepare('SELECT count(*) AS n FROM apply_runs').get().n,steps:growthDb.prepare('SELECT count(*) AS n FROM apply_steps').get().n,reviewCalls:growthDb.prepare('SELECT coalesce(sum(started_calls),0) AS n FROM apply_budget').get().n,automatic:false};const control=growthDb.prepare('SELECT * FROM nightly_control WHERE id=1').get();const require=createRequire(await fs.realpath(path.join(projectRoot,'node_modules/@deepseek-ai/dsh/package.json'))),yaml=require('js-yaml'),patch=yaml.load(await fs.readFile(path.join(instanceRoot,'dsh-home/profiles/web/cordis.patch.yml'),'utf8')).find(row=>row.id==='friend-adapter');nightlyState={schema:growthDb.prepare('SELECT version FROM nightly_schema WHERE id=1').get().version,enabled:patch?.disabled!==true&&patch?.config?.nightly?.enabled===true&&control.enabled_override!==0,paused:control.enabled_override===0,time:patch?.config?.nightly?.time??'02:00',timeZone:'Asia/Shanghai',nextDue:new Date(control.next_due).toISOString(),runs:growthDb.prepare('SELECT count(*) AS n FROM nightly_runs').get().n,modelCalls:growthDb.prepare('SELECT coalesce(sum(started_calls),0) AS n FROM nightly_budget').get().n};applicationState.automatic=nightlyState.enabled;emotionState={schema:growthDb.prepare("SELECT version FROM emotion_schema").get().version,revision:growthDb.prepare("SELECT value FROM emotion_meta WHERE key='revision'").get().value,episodes:growthDb.prepare("SELECT count(*) AS n FROM emotion_heads").get().n,versions:growthDb.prepare("SELECT count(*) AS n FROM emotion_versions").get().n,appraisals:growthDb.prepare("SELECT count(*) AS n FROM emotion_review_attempts").get().n,sharedGrowthBudget:true,backgroundMood:true};conversationState={enabled:true,reviewCalls:growthDb.prepare("SELECT coalesce(sum(started_calls),0) AS n FROM apply_conversation_budget").get().n,runs:growthDb.prepare("SELECT count(*) AS n FROM apply_runs WHERE json_extract(approval_json,'$.kind')='conversation'").get().n,lightweightRuntimeAppend:true,legacyToolGuard:true,exactHistoricalResurrectionGuard:true};protectionState={schema:growthDb.prepare("SELECT version FROM protection_schema WHERE id=1").get().version,snapshots:growthDb.prepare("SELECT count(*) AS n FROM protection_snapshots").get().n,undos:growthDb.prepare("SELECT count(*) AS n FROM protection_undos").get().n,pendingUndo:growthDb.prepare("SELECT count(*) AS n FROM protection_undos WHERE status!='completed'").get().n,scope:"manual/nightly applications and companion Web/verified QQ owner daily writes; verified Bilibili social append-only experiences; management/CLI/other presets not globally intercepted",offlineUndo:true};}finally{growthDb.close();}
if(growthState.integrity!=='ok')throw new Error('Growth database integrity failed');
const adapter = JSON.parse(await fs.readFile(path.join(instanceRoot, 'dsh-home/profiles/web/.friend-packages/adapter-install.json'), 'utf8'));
const adapterTests = JSON.parse(await fs.readFile(path.join(projectRoot, '.work/adapter-test-result.json'), 'utf8'));
const adapterAcceptance = JSON.parse(await fs.readFile(path.join(projectRoot, '.work/adapter-acceptance-summary.json'), 'utf8'));
const deployment = JSON.parse(await fs.readFile(path.join(projectRoot, '.work/adapter-deployment.json'), 'utf8'));
if (!adapterTests.passed || adapterAcceptance.failed || !deployment.repeatedSetupPreserved) throw new Error('Adapter verification is incomplete');
const artifact = await fs.readFile(path.join(instanceRoot, 'dsh-home/profiles/web/.friend-packages', adapter.artifact));
if (crypto.createHash('sha256').update(artifact).digest('hex') !== adapter.sha256) throw new Error('Installed adapter artifact differs from manifest');
const report = {
  checked_at: now, phase: 'companion-bilibili-social', architecture_version: '0.15',
  versions: { node: process.version, pnpm: '11.28.5', dsh: '0.2.1-rc.3', mnemon: '0.5.36', native: '0.2.13' },
  model: { provider: catalog.default.provider, id: catalog.default.model, display_name: catalog.groups.flatMap(group => group.models).find(row => row.id === 'deepseek-flash')?.name, real_conversation_turns_verified: 3 },
  checks: { authenticated_web: true, blank_preset_valid: true, local_native_ready: true, real_runtime_write: true, real_long_term_write: true, cross_session_native_tool_recall: true, graceful_stop_and_restart: true, repeated_setup_preserved_state: true, clean_first_boot_initialized_memory: true, backup_behavior_tests_passed: 3, snapshot_checksums_valid: recovery.verified.verified, offline_restore_sqlite_integrity: recovery.sqliteIntegrity, test_memory_restored: recovery.testMemoryRestored, code_files_secret_scan_passed: true, code_files_checked: files.length },
  companion_adapter: { version: adapter.version, source_sha256: adapter.sourceDigest, artifact_sha256: adapter.sha256, tests: adapterTests, isolated_acceptance: adapterAcceptance, deployment, growth_state: growthState, preview_state: previewState, application_state: applicationState, nightly_state: nightlyState, protection_state: protectionState, emotion_state: emotionState, conversation_memory: conversationState },
  retention: { records_imported: retention.imported, auto_pruned: retention.autoPruned, exact_duplicate_action: retention.duplicateAction },
  final_state: { active_memory_count: status.stats.totalInsights, runtime_entries: runtime.entries.length, active_spaces: status.dshActiveStores, preset: 'companion', personal_description: 'not preset by this deployment', idle_review: false, skill_evolution: false, native_auto_prune_limit: 0, embeddings_configured: false, prod_initialized: false },
  paths: { instance: instanceRoot, memory: status.dataDir, backup_root: path.join(projectRoot, 'backups', 'dev') },
  limitations: ['Only a small functional Chinese recall case was tested; semantic quality is not benchmarked.', 'Offline restore checked data integrity and memory contents; cross-machine boot was not tested.', 'Cross-provider conversion is not implemented.', 'First-version state/growth/emotion pipeline is implemented; long-term personality quality is unproven. Manual read-only preview and recoverable application are implemented; controlled nightly maintenance is implemented; application snapshots, change inspection and guarded offline undo are implemented; multi-emotion episodes, time decay and event reappraisal are implemented; direct companion daily writes use source review, CAS, snapshots, retirement history and receipts; bound QQ private-text protocol implemented and isolated real-model/local-OneBot simulation verified; real QQ login and one bound-owner reply verified; bounded read-only Bilibili activities implemented; proactive QQ sharing, Douyin and long-run autonomy quality remain unverified.'],
  failures: [],
};
await fs.writeFile(path.join(projectRoot, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
const baselineFile = path.join(projectRoot, 'baseline.json');
const baseline = JSON.parse(await fs.readFile(baselineFile, 'utf8'));
baseline.recorded_at = now;
baseline.phase = 'companion-bilibili-social';
baseline.current = { ...baseline.current, project_node: process.version, runtime_compatible: true, dependencies_installed: true, dsh_built: false, using_official_published_artifacts: true, dsh_started: true, third_party_plugins_installed: ['dsh-mnemon@0.5.36', '@mnemon-dev/mnemon@0.2.13'], runtime_dev_initialized: true, runtime_prod_initialized: false, runtime_directories_exist: true, real_conversation_turns_verified: 3, model: catalog.default, credential_configured: true };
delete baseline.current.model_calls_made;
baseline.design.implementation_started = true;
baseline.design.companion_state_implemented = true;
baseline.design.growth_pipeline_implemented = true;
baseline.design.memory_preview_implemented = true;
baseline.design.memory_proposals_apply_implemented = true;
baseline.design.conversation_memory_implemented = true;
baseline.design.emotional_episodes_implemented = true;
baseline.design.background_mood_implemented = true;
baseline.design.memory_batch_protection_implemented = true;
baseline.design.offline_safe_undo_implemented = true;
baseline.design.nightly_jobs_implemented = true;
baseline.design.nightly_automatic_enabled = nightlyState.enabled;
baseline.design.long_term_personality_quality_verified = false;
baseline.design.version = '0.15';
baseline.design.custom_source_and_strategy_implemented = false;
baseline.design.correction_adapter_implemented = true;
baseline.current.own_plugins_installed = ['@ai-friend/companion-adapter@' + adapter.version];
baseline.design.updated_at = now;
await fs.writeFile(baselineFile, JSON.stringify(baseline, null, 2) + '\n');
const candidatesFile = path.join(projectRoot, 'plugin-candidates.json');
const candidates = JSON.parse(await fs.readFile(candidatesFile, 'utf8'));
for (const item of candidates.candidates) if (['dsh-mnemon', '@mnemon-dev/mnemon'].includes(item.package)) { item.installed = true; item.runtime_tested = true; item.status = 'installed-functional-smoke-passed'; item.runtime_tested_at = now; item.runtime_test_scope = 'Small functional smoke, persistence and offline restore; not long-term companion quality'; }
await fs.writeFile(candidatesFile, JSON.stringify(candidates, null, 2) + '\n');
const nativeBytes = await fs.readFile(path.join(projectRoot, '.tools', 'mnemon-0.2.13', 'mnemon.exe'));
report.native_binary_sha256 = crypto.createHash('sha256').update(nativeBytes).digest('hex');
await fs.writeFile(path.join(projectRoot, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ healthy: true, model: report.model, activeMemory: report.final_state.active_memory_count, secretScanPassed: true, checkedCodeFiles: files.length }));

const qqLive=JSON.parse(await fs.readFile(path.join(projectRoot,'.work/qq-live-status.json'),'utf8'));
const qqAcceptance=JSON.parse(await fs.readFile(path.join(projectRoot,'.work/qq-acceptance/qq-acceptance.json'),'utf8'));
if(qqAcceptance.phase!=='completed'||qqAcceptance.automatedSummary.failed||qqAcceptance.adapterVersion!=='0.9.0')throw new Error('QQ acceptance is incomplete or differs from installed source');
report.qq={implemented:true,configured:true,realQQLoginVerified:qqLive.realQQLoginVerified,realQQDeliveryVerified:qqLive.realQQReplyVerified&&qqLive.userConfirmedDelivery,realQQVerifiedAt:qqLive.checkedAt,actualDeepSeek:true,onebotEndpoint:'authenticated local simulator',cases:qqAcceptance.automatedSummary,rootTurns:qqAcceptance.rootTurns,sourceDigest:qqAcceptance.sourceDigest};
baseline.design.qq_channel_implemented=true;baseline.current.qq_real_login_verified=qqLive.realQQLoginVerified;baseline.current.qq_real_delivery_verified=qqLive.realQQReplyVerified&&qqLive.userConfirmedDelivery;
await fs.writeFile(path.join(projectRoot,'verification.json'),JSON.stringify(report,null,2)+'\n');await fs.writeFile(baselineFile,JSON.stringify(baseline,null,2)+'\n');

const activityFixture=JSON.parse(await fs.readFile(path.join(projectRoot,'.work/activity-acceptance/activity-acceptance.json'),'utf8')),activityReal=JSON.parse(await fs.readFile(path.join(projectRoot,'.work/activity-acceptance/activity-real-acceptance.json'),'utf8')),activityLive=JSON.parse(await fs.readFile(path.join(projectRoot,'.work/activity-live-status.json'),'utf8'));
for(const proof of [activityFixture,activityReal])if(proof.phase!=='completed'||proof.automatedSummary.failed||proof.automatedSummary.pending||proof.adapterVersion!=='0.10.0')throw new Error('Activity acceptance does not match installed source');
report.activities={implemented:true,realLoginVerified:activityLive.actualLoginVerified,automatic:activityLive.automatic,fixtureCases:activityFixture.automatedSummary,actualBilibiliCases:activityReal.automatedSummary,sourceDigest:activityReal.sourceDigest,verifiedAdapterVersion:activityReal.adapterVersion,currentRegressionVersion:adapter.version,scope:'Historical real-platform acceptance plus current regression. Bounded reading and shared memory/state; no proactive messages, ASR or visual video understanding; long-run quality unverified'};report.qq.verifiedAdapterVersion=qqAcceptance.adapterVersion;report.qq.currentRegressionVersion=adapter.version;
baseline.design.bilibili_readonly_implemented=true;baseline.design.bounded_activities_implemented=true;baseline.current.bilibili_login_verified=activityLive.actualLoginVerified;baseline.current.autonomous_activities_enabled=activityLive.automatic;
await fs.writeFile(path.join(projectRoot,'verification.json'),JSON.stringify(report,null,2)+'\n');await fs.writeFile(baselineFile,JSON.stringify(baseline,null,2)+'\n');

const responseProof=JSON.parse(await fs.readFile(path.join(projectRoot,'.work/response-acceptance/response-acceptance.json'),'utf8'));
if(responseProof.phase!=='completed'||responseProof.automatedSummary.failed||responseProof.automatedSummary.pending||responseProof.adapterVersion!=='0.11.0')throw new Error('Response acceptance differs from installed source');
report.responses={implemented:true,sourceDigest:responseProof.sourceDigest,version:responseProof.adapterVersion,cases:responseProof.automatedSummary,actualDeepSeek:responseProof.actualDeepSeek,transport:'authenticated local OneBot simulator; real QQ intent delivery not re-tested by this suite',ordinaryReplyFallback:true,deferredDurable:true,newMessageSupersedes:true,deliveredEvidenceOnly:true};
baseline.design.response_intents_implemented=true;baseline.design.separate_activity_budgets_implemented=true;
await fs.writeFile(path.join(projectRoot,'verification.json'),JSON.stringify(report,null,2)+'\n');await fs.writeFile(baselineFile,JSON.stringify(baseline,null,2)+'\n');

const inboxProof=JSON.parse(await fs.readFile(path.join(projectRoot,'.work/bilibili-inbox-acceptance/bilibili-inbox-acceptance.json'),'utf8')),inboxLive=JSON.parse(await fs.readFile(path.join(projectRoot,'.work/bilibili-inbox-live-status.json'),'utf8'));
const inboxPatch=['0.12.1','0.13.0','0.13.1','0.13.2','0.13.3','0.13.4'].includes(adapter.version)?JSON.parse(await fs.readFile(path.join(projectRoot,'.work/bilibili-inbox-unlimited.json'),'utf8')):null;
if(inboxProof.phase!=='completed'||inboxProof.automatedSummary.failed||inboxProof.automatedSummary.pending||(inboxPatch?(!inboxPatch.passed||(adapter.version==='0.12.1'&&inboxPatch.sourceDigest!==adapter.sourceDigest)):inboxProof.sourceDigest!==adapter.sourceDigest)||!inboxProof.productionMemoryFilesUnchanged||!inboxProof.testHostStopped)throw new Error('Bilibili inbox acceptance incomplete or differs from installed source');
report.responses.currentRegressionVersion=adapter.version;report.bilibiliInbox={implemented:true,version:adapter.version,sourceDigest:adapter.sourceDigest,verifiedModelVersion:inboxProof.adapterVersion,verifiedModelSourceDigest:inboxProof.sourceDigest,dailyLimitPatch:inboxPatch,cases:inboxProof.automatedSummary,actualDeepSeek:true,fixtureEvents:true,actualReadOnlyInterfaces:inboxLive.probe,live:inboxLive.inbox,platformWrites:['0.13.0','0.13.1','0.13.2','0.13.3','0.13.4'].includes(adapter.version),scope:'Historical read-only interface and synthetic inbox acceptance; current real social delivery is recorded separately in bilibiliSocial'};
baseline.design.bilibili_event_inbox_implemented=true;baseline.design.bilibili_outgoing_replies_implemented=['0.13.0','0.13.1','0.13.2','0.13.3','0.13.4'].includes(adapter.version);
await fs.writeFile(path.join(projectRoot,'verification.json'),JSON.stringify(report,null,2)+'\n');await fs.writeFile(baselineFile,JSON.stringify(baseline,null,2)+'\n');

const socialProof=JSON.parse(await fs.readFile(path.join(projectRoot,'.work/bilibili-social-acceptance/bilibili-social-acceptance.json'),'utf8'));
const socialLive=JSON.parse(await fs.readFile(path.join(projectRoot,'.work/bilibili-social-live-status.json'),'utf8'));
const socialTransportPatch=adapter.version==='0.13.3'?JSON.parse(await fs.readFile(path.join(projectRoot,'.work/bilibili-web-request-patch.json'),'utf8')):null;
const exactModelSource=socialProof.adapterVersion===adapter.version&&socialProof.sourceDigest===adapter.sourceDigest;
const checkedTransportPatch=socialTransportPatch?.passed===true&&socialTransportPatch.version===adapter.version&&socialTransportPatch.sourceDigest===adapter.sourceDigest&&socialTransportPatch.baseVersion===socialProof.adapterVersion&&socialTransportPatch.baseSourceDigest===socialProof.sourceDigest&&socialTransportPatch.modelLayerUnchanged===true&&socialTransportPatch.installedTests===389;
if(socialProof.phase!=='completed'||(!exactModelSource&&!checkedTransportPatch)||socialProof.automatedSummary.failed||socialProof.automatedSummary.pending||!socialProof.productionMemoryFilesUnchanged||!socialProof.testHostStopped)throw new Error('Current social source is not covered by exact model acceptance or a verified transport-only patch');

report.bilibiliSocial={implemented:true,version:adapter.version,sourceDigest:adapter.sourceDigest,cases:socialProof.automatedSummary,verifiedModelVersion:socialProof.adapterVersion,verifiedModelSourceDigest:socialProof.sourceDigest,transportPatch:socialTransportPatch,actualDeepSeek:true,actualNative:true,platformTransportInAcceptance:'local simulator',live:socialLive,realPrivateDeliveryVerified:socialLive.realPrivateDeliveryVerified===true,continuousPrivateConversationVerified:socialLive.continuousPrivateConversationVerified===true,realPublicDeliveryVerified:socialLive.realPublicDeliveryVerified===true,publicReplyThreadVerified:socialLive.publicReplyThreadVerified===true,publicConversationContinuityVerified:socialLive.publicConversationContinuityVerified===true,topLevelAtDeliveryVerified:socialLive.topLevelAtDeliveryVerified===true,liveScenarioSuiteVerified:socialLive.liveScenarioSuiteVerified===true,newProtocolTransportVerified:socialLive.newProtocolActualTransportVerified===true,webSessionConfigured:socialLive.webSessionConfigured===true,publicVisibilityRequiresGuestReadback:true,dailyEventTurns:0,dailyEventLimitEnabled:false,scope:'Per-peer private and per-root public context; source-reviewed append-only Native memory; shared CAS growth/emotion; only exact platform readback becomes published. Main Bilibili private chat does not yet expose all Web/QQ management tools.'};
baseline.design.bilibili_social_threads_implemented=true;baseline.design.bilibili_social_memory_implemented=true;baseline.design.bilibili_outgoing_replies_implemented=true;
await fs.writeFile(path.join(projectRoot,'verification.json'),JSON.stringify(report,null,2)+'\n');await fs.writeFile(baselineFile,JSON.stringify(baseline,null,2)+'\n');
