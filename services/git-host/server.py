"""Demo Git host: serves bare repositories over HTTP with git http-backend.

Standard library only. At start it seeds the course repositories that do not
exist (seed.sh), then it serves /<name>.git/... for clone, fetch and push.
Push needs no credential: this host is for the course exercises only.

GET /healthz answers "ok"; GET / lists the repositories.
"""
import os
import re
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote

DATA = os.environ.get("GIT_HOST_DATA", "/data")
SEED_SCRIPT = os.environ.get("GIT_HOST_SEED_SCRIPT", os.path.join(os.path.dirname(os.path.abspath(__file__)), "seed.sh"))
MAX_BODY = 256 * 1024 * 1024
REPOSITORY_PATH = re.compile(r"/[A-Za-z0-9][A-Za-z0-9._-]*\.git/[A-Za-z0-9._/-]+")


def read_chunked(stream, limit):
    """Read a request body sent with Transfer-Encoding: chunked."""
    parts = []
    total = 0
    while True:
        size = int(stream.readline().split(b";", 1)[0].strip() or b"0", 16)
        if size == 0:
            while stream.readline().strip():
                pass
            return b"".join(parts)
        total += size
        if total > limit:
            raise ValueError("body too large")
        parts.append(stream.read(size))
        stream.readline()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "git-host"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    def plain(self, status, text):
        data = text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.handle_request(b"")

    def do_POST(self):
        try:
            if "chunked" in (self.headers.get("Transfer-Encoding") or "").lower():
                body = read_chunked(self.rfile, MAX_BODY)
            else:
                length = int(self.headers.get("Content-Length") or 0)
                if length < 0 or length > MAX_BODY:
                    raise ValueError("body too large")
                body = self.rfile.read(length)
        except ValueError:
            self.close_connection = True
            self.plain(413, "The request body is not valid or too large.\n")
            return
        self.handle_request(body)

    def handle_request(self, body):
        path, _, query = self.path.partition("?")
        path = unquote(path)
        if path == "/healthz":
            self.plain(200, "ok\n")
            return
        if path == "/":
            names = sorted(name for name in os.listdir(DATA) if name.endswith(".git"))
            self.plain(200, "".join(name + "\n" for name in names))
            return
        if not REPOSITORY_PATH.fullmatch(path) or ".." in path:
            self.plain(404, "No repository at this path. GET / lists the repositories.\n")
            return
        env = {"PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"), "HOME": os.environ.get("HOME", "/tmp"),
               "GIT_PROJECT_ROOT": DATA, "GIT_HTTP_EXPORT_ALL": "1", "GATEWAY_INTERFACE": "CGI/1.1",
               "REQUEST_METHOD": self.command, "PATH_INFO": path, "QUERY_STRING": query,
               "CONTENT_TYPE": self.headers.get("Content-Type") or "", "CONTENT_LENGTH": str(len(body)),
               "REMOTE_ADDR": self.client_address[0], "REMOTE_USER": "anonymous"}
        if self.headers.get("Content-Encoding"):
            env["HTTP_CONTENT_ENCODING"] = self.headers["Content-Encoding"]
        if self.headers.get("Git-Protocol"):
            env["GIT_PROTOCOL"] = self.headers["Git-Protocol"]
        done = subprocess.run(["git", "http-backend"], input=body, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if done.stderr:
            sys.stderr.write(done.stderr.decode("utf-8", errors="replace"))
        head, separator, payload = done.stdout.partition(b"\r\n\r\n")
        if not separator:
            head, separator, payload = done.stdout.partition(b"\n\n")
        if not separator:
            self.plain(500, "git http-backend gave no answer.\n")
            return
        status = 200
        headers = []
        for line in head.decode("latin-1").splitlines():
            name, _, value = line.partition(":")
            if name.lower() == "status":
                status = int(value.strip().split(" ", 1)[0])
            elif name and name.lower() != "content-length":
                headers.append((name.strip(), value.strip()))
        self.send_response(status)
        for name, value in headers:
            self.send_header(name, value)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def main():
    subprocess.run(["bash", SEED_SCRIPT], check=True)
    server = ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("PORT", "8080"))), Handler)
    server.daemon_threads = True
    sys.stderr.write("git-host serves %s on port %d\n" % (DATA, server.server_address[1]))
    server.serve_forever()


if __name__ == "__main__":
    main()
