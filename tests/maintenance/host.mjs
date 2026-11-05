import path from 'node:path';
import { pathToFileURL,fileURLToPath } from 'node:url';

const instance = process.env.AI_FRIEND_TEST_INSTANCE;
const port = process.env.AI_FRIEND_TEST_PORT;
if (!instance || !port) throw new Error('Isolated test instance and port are required');
process.once('message', message => {
  if (message?.command === 'stop') {
    process.disconnect();
    process.emit('SIGINT');
  }
});
process.chdir(path.join(instance, 'workspace'));
const project=fileURLToPath(new URL('../../',import.meta.url));
const bin=path.join(project,'node_modules/@deepseek-ai/dsh/lib/bin.js');
process.argv = [process.execPath, bin, 'web', '--host', '127.0.0.1', '--port', port, '--no-open'];
const { runCli } = await import(pathToFileURL(bin).href);
await runCli();
