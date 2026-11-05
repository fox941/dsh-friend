export const VIDEO_SETTINGS_KEY='bili-video:settings:v1';
export const videoSettingFields=[
 {key:'windowSeconds',kind:'int',min:5,max:120,label:'单个观察窗口最长（秒）',help:'首个窗口及后续窗口的上限；模型可以选择更短的片段。'},
 {key:'maxWindows',kind:'int',min:1,max:3,label:'每批最多观察窗口',help:'一批完成后释放执行器，由她决定继续、暂缓或停止。'},
 {key:'maxFrames',kind:'int',min:1,max:6,label:'普通观察每窗采样画面（张）',help:'用于普通分段观察，仍受原视觉请求上限约束。'},
 {key:'continuousFrames',kind:'int',min:4,max:24,label:'连续观看每窗采样画面（张）',help:'用于连续观看的时序理解；更多采样会增加处理时间和模型用量。'}
];
export function videoConfig(config={}){
 if(!config||typeof config!=='object'||Array.isArray(config))throw new Error('视频资源配置必须为对象');
 const out={enabled:config.enabled??true};if(typeof out.enabled!=='boolean')throw new Error('视频开关无效');
 for(const [key,fallback,min,max]of [['windowSeconds',60,5,120],['maxWindows',3,1,3],['maxFrames',4,1,6],['continuousFrames',12,4,24],['evidenceLimitBytes',256*1024*1024,1024*1024,1024*1024*1024]]){const n=config[key]??fallback;if(!Number.isSafeInteger(n)||n<min||n>max)throw new Error('视频资源配置超出范围');out[key]=n;}return out;
}
export function batchVideoConfig(value){
 const keys=['enabled','windowSeconds','maxWindows','maxFrames','continuousFrames','evidenceLimitBytes'];
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k)))throw new Error('原批次采样配置不完整，未使用新默认值覆盖');
 return Object.freeze(videoConfig(value));
}
function settingsObject(value,{stored=false}={}){
 const bad=()=>Object.assign(Error(stored?'已存视频配置暂不可核验，原任务与观察保留':'视频配置包含未知字段或越界值'),{status:stored?503:400,requestInvalid:!stored});
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!videoSettingFields.some(f=>f.key===k)))throw bad();
 for(const [key,n]of Object.entries(value)){const f=videoSettingFields.find(f=>f.key===key);if(!Number.isSafeInteger(n)||n<f.min||n>f.max)throw bad();}
 return Object.fromEntries(videoSettingFields.filter(f=>Object.hasOwn(value,f.key)).map(f=>[f.key,value[f.key]]));
}
/** Reads only. Missing policy inherits the profile; malformed policy stops new
 * video work without overwriting the stored configuration. */
export function readVideoSettings(db){
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='platform_meta'").get())return {revision:0,settings:{}};
 const raw=db.prepare('SELECT value FROM platform_meta WHERE key=?').get(VIDEO_SETTINGS_KEY)?.value;if(raw===undefined)return {revision:0,settings:{}};
 let value;try{value=JSON.parse(raw);}catch{throw Object.assign(Error('已存视频配置暂不可核验，原值保留'),{status:503});}
 if(!value||value.schema!=='ai-friend/bili-video-settings/1'||!Number.isSafeInteger(value.revision)||value.revision<1||value.revision>=Number.MAX_SAFE_INTEGER||Object.keys(value).some(k=>!['schema','revision','settings','updatedAt'].includes(k)))throw Object.assign(Error('已存视频配置版本无效，原值保留'),{status:503});
 return {...value,settings:settingsObject(value.settings,{stored:true})};
}
export function effectiveVideoConfig(db,base={}){return videoConfig({...base,...readVideoSettings(db).settings});}
/** Caller owns the transaction, shared with the existing settings receipt. */
export function writeVideoSettings(db,changes,at){
 const clean=settingsObject(changes),old=readVideoSettings(db),settings={...old.settings,...clean};
 if(!Object.keys(clean).length)throw Object.assign(Error('没有视频参数变更'),{requestInvalid:true,status:400});
 db.exec('CREATE TABLE IF NOT EXISTS platform_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
 const value={schema:'ai-friend/bili-video-settings/1',revision:old.revision+1,settings,updatedAt:at};
 db.prepare('INSERT INTO platform_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(VIDEO_SETTINGS_KEY,JSON.stringify(value));return value;
}
