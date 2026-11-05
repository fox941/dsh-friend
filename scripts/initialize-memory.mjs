import { connectDev } from './dev-client.mjs';
import {selectedInstance} from './paths.mjs';

const client = await connectDev();
const status = await client.rpc('dshMnemon/read', { endpoint: 'status', payload: {} });
if (!status.ok || !status.value.commandFound || !status.value.memorySystem.serving) throw new Error('Mnemon Native is not ready. Inspect the local plugin page before chatting.');
const directory = await client.rpc('dshMnemon/read', { endpoint: 'body-directory', payload: {} });
if (!directory.ok) throw new Error('Memory Space directory is unavailable');
if (directory.value.items.length === 0) {
  const created = await client.rpc('dshMnemon/write', { endpoint: 'body-create', payload: {
    name:selectedInstance.id==='test'?'隔离测试记忆':'陪伴记忆',description:selectedInstance.id==='test'?'独立测试角色的数据，不属于主实例的真实经历。':'本实例的长期事实、约定与共同经历；开发验收资料必须明确标注为测试。',
  } });
  if (!created.ok) throw new Error(`Cannot initialize the local Memory Space: ${created.error.message}`);
  const activated = await client.rpc('dshMnemon/activation', { endpoint: 'body', payload: { memoryBodyId: created.value.id, active: true } });
  if (!activated.ok) throw new Error(`Cannot activate the local Memory Space: ${activated.error.message}`);
}
console.log('Local memory is ready.');
