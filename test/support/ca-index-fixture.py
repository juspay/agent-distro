"""A stub of the content-addressed index: one port answers with the entry a test
wrote, the other refuses with 404, so a test can drive a published revision, an
unpublished one, and an entry that names the signed package alone (which is what
a darwin system gets).

Serves TLS: the updater fetches only an https base, so the stub has to be one
— a self-signed certificate the test points the updater's trust at
(NODE_EXTRA_CA_CERTS)."""
import http.server
import ssl
import sys

status, port, certificate, key = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3], sys.argv[4]
entry = sys.argv[5]
# Where the server appends every path it was asked for, so a test can check
# which entry the updater fetched (`default.json`, or the attribute a config
# names instead).
requests = sys.argv[6] if len(sys.argv) > 6 else None


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if requests is not None:
            with open(requests, 'a') as log:
                log.write(self.path + '\n')
        body = open(entry, 'rb').read() if status == 200 else b''
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
