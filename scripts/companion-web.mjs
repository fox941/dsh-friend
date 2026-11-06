/** Mount the shipped DSH read-only web tools in our explicitly composed preset. */
export function ensureCompanionWeb(patches,{instance='main'}={}){
 if(instance==='test')return false;
 if(!Array.isArray(patches))throw Error('Profile overrides must be a patch list');
 const presets=patches.flatMap(row=>row.insert??[]).filter(row=>row.id==='preset-companion');
 if(presets.length!==1||!Array.isArray(presets[0].config?.plugins))throw Error('Expected one existing companion preset; no configuration replaced');
 const plugins=presets[0].config.plugins,entries=plugins.filter(row=>row.id==='tool-web');
 if(entries.length>1||entries.some(row=>row.name!=='@deepseek-ai/dsh-tool-web'))throw Error('Existing tool-web entry differs; preserved for review');
 let changed=false;
 if(!entries.length){plugins.push({id:'tool-web',name:'@deepseek-ai/dsh-tool-web',config:{search:true,fetch:true,searchMaxResults:6,searchMaxQueries:2,searchTimeoutMs:60000,fetchTimeoutMs:30000,fetchMaxOutputChars:30000}});changed=true;}
 // The stock Messages-search route has a separate model setting. Use the
 // already shipped direct Search API on a fresh configuration; retain any
 // explicit user provider selection, credentials and endpoint settings.
 let web=patches.find(row=>row.id==='web');
 if(patches.filter(row=>row.id==='web').length>1)throw Error('Duplicate web configuration; preserved for review');
 if(!web){web={id:'web',config:{searchProvider:'deepseek-search-api',fetchProvider:'http'}};patches.push(web);changed=true;}
 else if(web.config!==undefined&&(!web.config||Array.isArray(web.config)||typeof web.config!=='object'))throw Error('Invalid existing web configuration');
 else {web.config??={};for(const [key,value]of Object.entries({searchProvider:'deepseek-search-api',fetchProvider:'http'}))if(web.config[key]===undefined){web.config[key]=value;changed=true;}}
 return changed;
}
