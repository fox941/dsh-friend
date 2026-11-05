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
const bin = process.env.AI_FRIEND_PROJECT_ROOT?path.join(process.env.AI_FRIEND_PROJECT_ROOT,'node_modules/@deepseek-ai/dsh/lib/bin.js'):fileURLToPath(new URL('../../node_modules/@deepseek-ai/dsh/lib/bin.js',import.meta.url));
process.argv = [process.execPath, bin, 'web', '--host', '127.0.0.1', '--port', port, '--no-open'];
const { runCli } = await import(pathToFileURL(bin).href);
await runCli();
