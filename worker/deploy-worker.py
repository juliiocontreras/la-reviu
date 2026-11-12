# La Reviú — despliegue del Worker por API (sin wrangler).
# Bindings: D1 la-reviu + ALLOWED_ORIGIN (Pages). Sin secretos en el primer
# deploy: GOOGLE_CLIENT_ID/SECRET y RESEND_API_KEY se añaden después con
# `wrangler secret put` o desde el dashboard (los valores no están en este repo).
import sys, json, urllib.request, uuid
sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args): raise RuntimeError("redirect refused")
ACCT = "0e75afd1ae301052497d802bf284ee23"
SCRIPT = "la-reviu"
D1_ID = "e85f2197-22ce-4b98-9a7a-1d82302a9458"
code = open('/home/hatch/workspace/la-reviu/worker/worker.js', 'rb').read()
metadata = {
  "main_module": "worker.js",
  "compatibility_date": "2025-04-01",
  "bindings": [
    {"type": "d1", "name": "DB", "id": D1_ID},
    {"type": "plain_text", "name": "ALLOWED_ORIGIN", "text": "https://la-reviu.pages.dev"},
  ],
}
boundary = "----cfdeploy" + uuid.uuid4().hex
body = b""
def part(headers, data):
    global body
    body += ("--" + boundary + "\r\n").encode()
    for k, v in headers.items(): body += (k + ": " + v + "\r\n").encode()
    body += b"\r\n" + data + b"\r\n"
part({"Content-Disposition": 'form-data; name="metadata"', "Content-Type": "application/json"}, json.dumps(metadata).encode())
part({"Content-Disposition": 'form-data; name="worker.js"; filename="worker.js"', "Content-Type": "application/javascript+module"}, code)
body += ("--" + boundary + "--\r\n").encode()
def call(method, path, data=None, ctype=None):
    req = urllib.request.Request(f"https://api.cloudflare.com/client/v4{path}", data=data, method=method)
    if ctype: req.add_header("Content-Type", ctype)
    add_surrogate_to_request(req, "custom.cloudflare", allowed_hosts=["api.cloudflare.com"])
    try:
        with urllib.request.build_opener(NoRedirect()).open(req, timeout=60) as r:
            return r.status, r.read().decode()
    except Exception as e:
        try: return getattr(e, 'code', None), e.read().decode()
        except Exception: return None, str(e)
s, b = call("PUT", f"/accounts/{ACCT}/workers/scripts/{SCRIPT}", body, f"multipart/form-data; boundary={boundary}")
print("DEPLOY:", s); print(b[:1500])
s, b = call("GET", f"/accounts/{ACCT}/workers/subdomain")
print("SUBDOMAIN:", s, b[:400])
s, b = call("GET", f"/accounts/{ACCT}/workers/scripts/{SCRIPT}/settings")
print("SETTINGS:", s, b[:1200])
