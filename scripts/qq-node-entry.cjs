const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');

const project = path.resolve(__dirname, '..');
const backend = path.join(project, '.tools', 'napcat-node-v4.18.41');
const engine = path.join(project, '.tools', 'napcat-v4.18.41', 'napcat.ai-friend.mjs');
const files = {
  NAPCAT_WRAPPER_PATH: path.join(backend, 'wrapper.node'),
  NAPCAT_QQ_PACKAGE_INFO_PATH: path.join(backend, 'package.json'),
  NAPCAT_QQ_VERSION_CONFIG_PATH: path.join(backend, 'config.json'),
};

for (const file of [...Object.values(files), engine]) {
  if (!fs.statSync(file).isFile()) throw new Error('Missing QQ component: ' + file);
}
Object.assign(process.env, files, {NAPCAT_DISABLE_PIPE: '1'});
import(pathToFileURL(engine).href).catch(error => {
  console.error(error.stack || String(error));
  process.exit(1);
});
