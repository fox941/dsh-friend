import {startManagedHost} from '../../scripts/host.mjs';
const [project,bin]=process.argv.slice(2);
await startManagedHost({project,root:project+'/runtime/dev',bin,port:0});
