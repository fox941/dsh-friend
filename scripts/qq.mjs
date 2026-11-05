import {instanceId as selectedId} from './paths.mjs';
import {requireMain} from './instances.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {createInterface} from 'node:readline/promises';
import {instanceRoot} from './paths.mjs';
import {acquireOfflineLease} from './protection-control.mjs';
const action=process.argv[2]??'status';if(selectedId==='test'){if(action!=='status')requireMain('QQ操作');console.log(JSON.stringify({instance:'test',configured:false,enabled:false,onebotConnected:false,realQQLoginVerified:false,scope:'隔离测试：不查询或连接真实QQ'}));process.exit(0);}let lease,terminal;
async function liveLogin(require,config){
  if(!config.configured)return {onebotConnected:false,realQQLoginVerified:false};
  const packageFile=await fs.realpath(require.resolve('@ai-friend/companion-adapter/qq-offline')),ws=createRequire(packageFile)('ws');
  return new Promise(resolve=>{const result={onebotConnected:false,realQQLoginVerified:false},socket=new ws.WebSocket(config.url,{headers:{Authorization:'Bearer '+config.accessToken},maxPayload:1048576});let done=false;
    const finish=()=>{if(done)return;done=true;clearTimeout(timer);socket.terminate();resolve(result);},timer=setTimeout(finish,4000);
    socket.on('open',()=>{result.onebotConnected=true;socket.send(JSON.stringify({action:'get_login_info',params:{},echo:'friend-qq-status'}));});socket.on('message',bytes=>{try{const value=JSON.parse(bytes.toString());if(value.echo==='friend-qq-status'){result.realQQLoginVerified=value.status==='ok'&&String(value.data?.user_id)===config.botQQ;finish();}}catch{}});socket.on('error',finish);socket.on('close',finish);
  });
}
try{
  const require=createRequire(path.join(instanceRoot,'dsh-home/profiles/web/package.json'));
  const api=await import(pathToFileURL(require.resolve('@ai-friend/companion-adapter/qq-offline')));
  if(action==='status')console.log(JSON.stringify({...await api.qqLocalStatus(instanceRoot),...await liveLogin(require,await api.readQQSettings(instanceRoot)),checkedAt:new Date().toISOString(),note:'实际QQ登录由本机OneBot实时只读查询；DSH处理状态请查看friend_qq_status。'},null,2));
  else if(action==='configure'){
    lease=await acquireOfflineLease(instanceRoot);const prior=await api.readQQSettings(instanceRoot);
    let [ownerQQ,botQQ]=process.argv.slice(3);
    if(!ownerQQ||!botQQ){if(!process.stdin.isTTY)throw new Error('用法：qq.mjs configure <主用户QQ号> <AI的QQ号>；或双击 Configure-QQ.cmd 交互输入。');terminal=createInterface({input:process.stdin,output:process.stdout});ownerQQ=ownerQQ||(await terminal.question('你的主 QQ 号'+(prior.ownerQQ?' ['+prior.ownerQQ+']':'')+'：')).trim()||prior.ownerQQ;botQQ=botQQ||(await terminal.question('AI 使用的 QQ 号'+(prior.botQQ?' ['+prior.botQQ+']':'')+'：')).trim()||prior.botQQ;}
    const result=await api.configureQQ(instanceRoot,{ownerQQ,botQQ},{assertOffline:lease.assertOffline});console.log(JSON.stringify(result,null,2));console.log('配置完成。运行 Start-QQ.cmd 扫码登录 AI 账号，再运行 Start-Dev.cmd。');
  }else if(action==='launch-info'){
    const config=await api.readQQSettings(instanceRoot);if(!config.configured||!config.enabled)throw new Error('请先停止 DSH 并运行 Configure-QQ.cmd，绑定两个不同的QQ账号。');
    const workdir=path.join(instanceRoot,'channels/qq/napcat'),web=JSON.parse(await fs.readFile(path.join(workdir,'config/webui.json'),'utf8'));
    console.log(JSON.stringify({botQQ:config.botQQ,port:Number(new URL(config.url).port)||80,webPort:web.port,workdir}));
  }else throw new Error('用法：qq.mjs status|configure|launch-info');
}catch(error){console.error(error.message);process.exitCode=1;}finally{terminal?.close();await lease?.close();}
