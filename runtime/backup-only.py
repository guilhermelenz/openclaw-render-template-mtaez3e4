"""Temporary retirement export server. Never starts AlphaClaw or its workers."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import os, re, shutil
ROOT = Path('/tmp/alphaclaw-export')
ROOT.mkdir(mode=0o700, exist_ok=True)
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass
    def do_GET(self):
        if self.path == '/health':
            body = b'backup-maintenance'
            self.send_response(200)
            self.end_headers()
            self.wfile.write(body)
            return
        if not re.fullmatch(r'/[a-f0-9]{64}\.enc', self.path):
            self.send_error(404)
            return
        target = ROOT / self.path[1:]
        if target.is_symlink() or not target.is_file():
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header('Content-Type', 'application/octet-stream')
        self.send_header('Content-Length', str(target.stat().st_size))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        with target.open('rb') as f:
            shutil.copyfileobj(f, self.wfile, 1024*1024)
ThreadingHTTPServer(('0.0.0.0', int(os.environ.get('PORT', '3000'))), Handler).serve_forever()
