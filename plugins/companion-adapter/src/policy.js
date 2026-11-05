import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { parseMemorySpaceRegistry, MEMORY_SPACES_DIRECTORY, MEMORY_SPACE_REGISTRY_FILE } from 'dsh-mnemon-source-memory-spaces/contracts';

export function policyReader({home,memoryDir,writeEnabled=true}) {
  const file=path.join(home,'profiles/web/cordis.patch.yml');
  return () => {
    const disabled={enabled:false,writeEnabled:false,spaces:[],cliPath:'',issue:'记忆配置尚未就绪'};
    try {
      const entries=parse(fs.readFileSync(file,'utf8'));
      if (!Array.isArray(entries)) return disabled;
      const entry=entries.find(row=>row.id==='mnemon');
      const source=entries.find(row=>row.id==='mnemon-source-memory-spaces');
      const config=entry?.config;
      if (!config || entry.disabled===true || source?.disabled===true || config.storageScope!=='custom' || path.resolve(config.dataDir??'')!==path.resolve(memoryDir)) return {...disabled,issue:'仅支持本实例明确配置的 Native 自定义记忆目录'};
      const providers=source?.config?.providers;
      if (providers && !providers.some(row=>(typeof row==='string'?row:row.use)==='dsh-mnemon-provider-mnemon-native')) return {...disabled,issue:'本地 Native 提供者未启用'};
      if (typeof config.cliPath!=='string' || !fs.existsSync(config.cliPath) || (process.platform==='win32'&&!config.cliPath.toLowerCase().endsWith('.exe'))) return {...disabled,issue:'Native 可执行程序不可用'};
      // This release deliberately shares the existing native environment, not a second embedding route.
      if(config.embedding?.enabled===true)return {...disabled,issue:'适配插件尚未验证 DSH 接管的自定义嵌入配置，请先停用适配写入或完成适配'};
      let spaces=[];
      const registry=path.join(memoryDir,MEMORY_SPACES_DIRECTORY,MEMORY_SPACE_REGISTRY_FILE);
      if(fs.existsSync(registry))spaces=parseMemorySpaceRegistry(JSON.parse(fs.readFileSync(registry,'utf8'))).bodies;
      const runtime=entries.find(row=>row.id==='mnemon-source-runtime');
      const previewRuntimeSupported=config.runtimeUserScope==='storage'&&runtime?.disabled!==true&&runtime?.config?.dataDir===undefined&&runtime?.config?.userDataDir===undefined;
      return {runtimeLimits:{memoryLimitBytes:config.runtimeMemory?.memoryLimitBytes??10240,userLimitBytes:config.runtimeMemory?.userLimitBytes??4096},previewRuntimeSupported,enabled:true,writeEnabled:writeEnabled&&config.writeEnabled===true,spaces,cliPath:config.cliPath,issue:null};
    } catch { return disabled; }
  };
}
