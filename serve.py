# DISCFORM launcher: Python's built-in web server plus no-cache headers.
# Without them, browsers cache the JS modules and keep running stale code
# after an update.
import http.server
import os
import sys

os.chdir(os.path.dirname(os.path.abspath(__file__)))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8437


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()


if __name__ == '__main__':
    print(f'DISCFORM running at http://localhost:{PORT}  (Ctrl+C to stop)')
    http.server.ThreadingHTTPServer(('', PORT), Handler).serve_forever()
