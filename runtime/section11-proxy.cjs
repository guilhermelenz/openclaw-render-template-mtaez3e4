const http = require('node:http');
const {spawn} = require('node:child_process');
const {existsSync} = require('node:fs');

module.exports = function registerSection11(app) {
  const repository = '/data/section11/repository';
  if (!process.env.SECTION11_REPOSITORY || !existsSync(repository + '/proactive/server.py')) return;
  // Match the session-signing password captured by host auth registration.
  // Later .env reloads must not change this for restarted child processes.
  const setupPassword = process.env.SETUP_PASSWORD;
  const remote = process.env.SECTION11_MODE === 'chatgpt';
  let stopping = false;
  const children = new Set();
  const supervise = (module) => {
  let failures = 0;
  const start = () => {
    if (stopping) return;
    const python = module === 'remote.server' ? '/opt/section11/bin/python' : 'python3';
    const child = spawn(python, ['-m', module], {cwd:repository, env:{...process.env, SETUP_PASSWORD:setupPassword, ...(remote ? {SECTION11_ENABLE_NOTIFICATIONS:'false'} : {})}, stdio:['ignore','ignore','ignore']});
    children.add(child);
    const retry = () => {
      children.delete(child);
      if (!stopping) {
        failures++;
        console.error('Section 11 process stopped; restarting.');
        setTimeout(start, Math.min(60000, 1000 * 2 ** Math.min(failures, 6))).unref();
      }
    };
    child.once('exit', retry);
    child.once('error', () => { console.error('Section 11 ingress could not start.'); });
  };
  start();
  };
  supervise('proactive.server');
  if (remote) supervise('remote.server');
  if (!remote && process.env.SECTION11_ENABLE_NOTIFICATIONS === 'true' && existsSync(repository + '/proactive/worker.py')) supervise('proactive.worker');
  process.once('exit', () => { stopping=true; for (const child of children) child.kill(); });
  app.use((req,res,next) => {
    const path=req.url.split('?')[0];
    const mcpPaths = ['/section11/mcp','/section11/connect','/section11/health','/authorize','/token','/register','/revoke','/.well-known/oauth-authorization-server','/.well-known/oauth-protected-resource/section11/mcp'];
    const isMcp = remote && mcpPaths.includes(path);
    if (!isMcp && path !== '/section11' && !path.startsWith('/section11/')) return next();
    const port = isMcp ? 3002 : 3001;
    const upstream = http.request({hostname:'127.0.0.1',port,path:req.url,method:req.method,
      headers:{...req.headers,host:`127.0.0.1:${port}`},timeout:120000}, response => {
      res.writeHead(response.statusCode,response.headers);
      response.pipe(res);
    });
    upstream.on('timeout',()=>upstream.destroy());
    upstream.on('error',()=>{if(!res.headersSent) res.writeHead(503,{'Content-Type':'text/plain'});res.end('Section 11 is starting. Please try again shortly.');});
    req.on('aborted',()=>upstream.destroy());
    req.pipe(upstream);
  });
};
