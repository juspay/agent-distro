"""A stub of the content-addressed index: one port answers with the pair a test
wrote to /tmp/ca-pair.json, the other refuses with 404, so a test can drive
both the published and the unpublished revision.

Serves TLS: the updater fetches only an https base, so the stub has to be one
— a self-signed certificate the test points the updater's trust at
(NODE_EXTRA_CA_CERTS)."""
import http.server
import ssl
import sys

status, port, certificate, key = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3], sys.argv[4]


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


server = http.server.HTTPServer(('127.0.0.1', port), Handler)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
# A stub for a test, but with the floor a server should have: TLS 1.0 and 1.1
# are not versions to offer anyone.
context.minimum_version = ssl.TLSVersion.TLSv1_2
context.load_cert_chain(certificate, key)
server.socket = context.wrap_socket(server.socket, server_side=True)
server.serve_forever()
