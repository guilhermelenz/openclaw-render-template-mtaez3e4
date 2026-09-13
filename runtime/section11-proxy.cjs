const http = require('node:http');
const {spawn} = require('node:child_process');
const {existsSync} = require('node:fs');

module.exports = function registerSection11(app) {
  const repository = '/data/section11/repository';
  if (!process.env.SECTION11_REPOSITORY || !existsSync(repository + '/proactive/server.py')) return;
  // Match the session-signing password captured by host auth registration.
  // Later .env reloads must not change this for restarted child processes.
  const setupPassword = process.env.SETUP_PASSWORD;
  let stopping = false;
  const children = new Set();
  const supervise = (module) => {
  let failures = 0;
  const start = () => {
    if (stopping) return;
    const child = spawn('python3', ['-m', module], {cwd:repository, env:{...process.env, SETUP_PASSWORD:setupPassword}, stdio:['ignore','ignore','ignore']});
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
  if (process.env.SECTION11_ENABLE_NOTIFICATIONS === 'true' && existsSync(repository + '/proactive/worker.py')) supervise('proactive.worker');
  process.once('exit', () => { stopping=true; for (const child of children) child.kill(); });
  app.use((req,res,next) => {
    const path=req.url.split('?')[0];
    if (path !== '/section11' && !path.startsWith('/section11/')) return next();
    const upstream = http.request({hostname:'127.0.0.1',port:3001,path:req.url,method:req.method,
      headers:{...req.headers,host:'127.0.0.1:3001'},timeout:35000}, response => {
      res.writeHead(response.statusCode,response.headers);
      response.pipe(res);
    });
    upstream.on('timeout',()=>upstream.destroy());
    upstream.on('error',()=>{if(!res.headersSent) res.writeHead(503,{'Content-Type':'text/plain'});res.end('Section 11 is starting. Please try again shortly.');});
    req.on('aborted',()=>upstream.destroy());
    req.pipe(upstream);
  });
};
