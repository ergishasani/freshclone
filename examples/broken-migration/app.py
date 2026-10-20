import sqlite3
from http.server import BaseHTTPRequestHandler, HTTPServer
with sqlite3.connect('app.sqlite3') as database:
    database.execute('SELECT count(*) FROM users').fetchone()


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'ready')


HTTPServer(('0.0.0.0', 8000), Handler).serve_forever()
