"""The gateway deliberately omits profile aliases and requires authentication."""
from http.server import BaseHTTPRequestHandler, HTTPServer
import json


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != '/v1/models' or self.headers.get('Authorization') != 'Bearer test-api-key':
            self.send_error(403)
            return
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({'data': [{'id': 'served-large'}, {'id': 'served-small'}]}).encode())


HTTPServer(('127.0.0.1', 8080), Handler).serve_forever()
