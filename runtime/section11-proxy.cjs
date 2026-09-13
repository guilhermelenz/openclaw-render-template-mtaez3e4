const http = require('node:http');
const {spawn} = require('node:child_process');
const {existsSync} = require('node:fs');

module.exports = function registerSection11(app) {
  const repository = '/data/section11/repository';
  if (!process.env.SECTION11_REPOSITORY || !existsSync(repository + '/proactive/server.py')) return;
  let stopping = false;
  let child;
  let failures = 0;
  const start = () => {
    if (stopping) return;
    child = spawn('python3', ['-m', 'proactive.server'], {cwd:repository, env:process.env, stdio:['ignore','ignore','ignore']});
    const retry = () => {
      if (!stopping) {
        failures++;
        console.error('Section 11 ingress stopped; restarting.');
        setTimeout(start, Math.min(60000, 1000 * 2 ** Math.min(failures, 6))).unref();
      }
    };
    child.once('exit', retry);
    child.once('error', () => { console.error('Section 11 ingress could not start.'); });
  };
  start();
  process.once('exit', () => { stopping=true; child?.kill(); });
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
