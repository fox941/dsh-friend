import path from 'node:path';
import fs from 'node:fs/promises';
import {initializeFresh} from './fresh-initialize.mjs';
const project=path.resolve(import.meta.dirname,'..'),[id,output]=process.argv.slice(2);
if(path.resolve(output)!==path.join(project,'.work/fresh-identity.json'))throw Error('Invalid fresh initialization output');
const value=await initializeFresh(project,id);await fs.writeFile(output,JSON.stringify(value,null,2)+'\n');
console.log('Created a new role identity with empty local memory and growth. No platform login or message was performed.');
