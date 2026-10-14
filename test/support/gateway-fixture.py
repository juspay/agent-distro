"""The gateway serves the profile's aliases and one model no profile names."""
from http.server import BaseHTTPRequestHandler, HTTPServer
import json

# The aliases a profile's `gateway.models` names, plus a model only the
# gateway has: a model list that showed up in the harness can then only have
# come from discovery.
MODELS = ['open-large', 'open-fast', 'served-only']
INFO = {
    'mode': 'chat',
    'max_input_tokens': 200000,
    'max_output_tokens': 8192,
    'input_cost_per_token': 1e-6,
    'output_cost_per_token': 2e-6,
    'supports_function_calling': True,
}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.headers.get('Authorization') != 'Bearer test-api-key':
            self.send_error(403)
            return
        if self.path == '/v1/models':
            body = {'data': [{'id': model, 'object': 'model'} for model in MODELS]}
        elif self.path == '/v1/model/info':
            body = {'data': [{'model_name': model, 'model_info': INFO} for model in MODELS]}
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(body).encode())


HTTPServer(('127.0.0.1', 8080), Handler).serve_forever()
