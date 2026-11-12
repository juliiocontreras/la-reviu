import sys, json, urllib.request, uuid
# La Reviú — despliegue del Worker (OBSOLETO: no ejecutar).
# Usar `python3 deploy-worker.py` (mismo patrón, sin bindings heredados).
# Este archivo quedó desactualizado en la reestructura 2026-11-12: hereda
# GOOGLE_CLIENT_ID/SECRET (OAuth eliminado) y apunta ALLOWED_ORIGIN a una
# ruta /la-reviu que ya no existe.
sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args): raise RuntimeError("redirect refused")
ACCT = "0e75afd1ae301052497d802bf284ee23"
SCRIPT = "la-reviu"
D1_ID = "e85f2197-22ce-4b98-9a7a-1d82302a9458"  # UUID de la base D1 `la-reviu`
code = open('/home/hatch/workspace/la-reviu/worker/worker.js', 'rb').read()
metadata = {
  "main_module": "worker.js",
  "compatibility_date": "2025-04-01",
  "bindings": [
    {"type": "d1", "name": "DB", "id": D1_ID},
    {"type": "inherit", "name": "GOOGLE_CLIENT_ID"},
    {"type": "inherit", "name": "GOOGLE_CLIENT_SECRET"},
    {"type": "inherit", "name": "RESEND_API_KEY"},
    {"type": "plain_text", "name": "ALLOWED_ORIGIN", "text": "https://la-reviu.pages.dev/la-reviu"},
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
url = f"https://api.cloudflare.com/client/v4/accounts/{ACCT}/workers/scripts/{SCRIPT}"
req = urllib.request.Request(url, data=body, method="PUT")
req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
add_surrogate_to_request(req, "custom.cloudflare", allowed_hosts=["api.cloudflare.com"])
try:
    with urllib.request.build_opener(NoRedirect()).open(req, timeout=60) as r:
        print("STATUS", r.status)
        print(r.read().decode()[:2500])
except Exception as e:
    print("ERR", e)
    try: print(e.read().decode()[:2500])
    except Exception as e2: print(e2)
