import {readFileSync,writeFileSync} from 'node:fs';
const path='/app/node_modules/@chrysb/alphaclaw/lib/server.js';
const source=readFileSync(path,'utf8');
const anchor='const app = express();';
const injection="require('/app/runtime/section11-proxy.cjs')(app);";
if(!source.includes(injection)) {
  if(source.split(anchor).length!==2) throw new Error('AlphaClaw ingress anchor changed');
  writeFileSync(path,source.replace(anchor,anchor+'\n'+injection));
}
