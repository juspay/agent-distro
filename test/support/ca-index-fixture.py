"""A stub of the content-addressed index: one port answers with the pair a test
wrote to /tmp/ca-pair.json, the other refuses with 404, so a test can drive
both the published and the unpublished revision."""
import http.server
import sys

status, port = int(sys.argv[1]), int(sys.argv[2])


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = open('/tmp/ca-pair.json', 'rb').read() if status == 200 else b''
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


http.server.HTTPServer(('127.0.0.1', port), Handler).serve_forever()
