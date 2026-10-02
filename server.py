#!/usr/bin/env python3
"""Le prochain date — serveur MVP (bibliothèque standard uniquement).

Lancer :  ADMIN_PASSWORD="mon-mot-de-passe" python3 server.py
Variables : PORT (8000), ADMIN_PASSWORD, HOST_NAME (Lucas), DATA_DIR (./data)
"""
import base64
import csv
import hashlib
import hmac
import io
import json
import mimetypes
import os
import re
import secrets
import sqlite3
import threading
import time
from datetime import datetime, timezone
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).parent.resolve()
PUBLIC = ROOT / "public"
DATA_DIR = Path(os.environ.get("DATA_DIR", ROOT / "data")).resolve()
UPLOADS = DATA_DIR / "uploads"
PORT = int(os.environ.get("PORT", "8000"))
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "changeme")
DEFAULT_HOST = os.environ.get("HOST_NAME", "Lucas")
DEFAULT_WELCOME = "Bonjour {name}, on va organiser ensemble ton prochain date avec {host} ?"
SESSION_TTL = 60 * 60 * 24 * 14

DATA_DIR.mkdir(parents=True, exist_ok=True)
UPLOADS.mkdir(parents=True, exist_ok=True)

# ---------------------------------------------------------------- stockage --
LOCK = threading.RLock()
DB = sqlite3.connect(DATA_DIR / "date.db", check_same_thread=False)
DB.execute(
    "CREATE TABLE IF NOT EXISTS invitations ("
    " id TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL, status TEXT NOT NULL,"
    " data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"
)
DB.commit()

key_file = DATA_DIR / "secret.key"
if not key_file.exists():
    key_file.write_text(secrets.token_hex(32))
SECRET = key_file.read_text().strip().encode()


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def row_to_inv(row):
    inv = json.loads(row[3])
    inv.update(id=row[0], token=row[1], status=row[2], createdAt=row[4], updatedAt=row[5])
    return inv


def load_all():
    with LOCK:
        rows = DB.execute("SELECT * FROM invitations ORDER BY created_at DESC, rowid DESC").fetchall()
    return [row_to_inv(r) for r in rows]


def load(inv_id=None, token=None):
    col, val = ("id", inv_id) if inv_id else ("token", token)
    with LOCK:
        row = DB.execute("SELECT * FROM invitations WHERE %s=?" % col, (val,)).fetchone()
    return row_to_inv(row) if row else None


BODY_FIELDS = ("recipientName", "hostName", "region", "welcomeMessage", "ideas", "responses", "preference", "availability")


def save(inv):
    inv["updatedAt"] = now()
    body = json.dumps({k: inv.get(k) for k in BODY_FIELDS}, ensure_ascii=False)
    with LOCK:
        DB.execute(
            "INSERT INTO invitations (id, token, status, data, created_at, updated_at) VALUES (?,?,?,?,?,?)"
            " ON CONFLICT(id) DO UPDATE SET status=excluded.status, data=excluded.data, updated_at=excluded.updated_at",
            (inv["id"], inv["token"], inv["status"], body, inv["createdAt"], inv["updatedAt"]),
        )
        DB.commit()
    return inv


def delete_inv(inv_id):
    with LOCK:
        DB.execute("DELETE FROM invitations WHERE id=?", (inv_id,))
        DB.commit()


# ------------------------------------------------------ idées par défaut ----
def default_ideas(region):
    place = region or "chez vous"
    base = [
        ("Aller à la plage", "Les pieds dans le sable, le bruit des vagues et une lumière qui ne demande rien de plus.",
         ["Marcher au bord de l'eau", "Pique-nique simple au coucher du soleil", "Un glacier sur le front de mer"],
         "Gratuit · 2 à 3 h", "/img/plage.svg"),
        ("Boire un verre", "Un endroit chaleureux, une carte courte, et le temps de vraiment discuter.",
         ["Un bar à vin ou une terrasse tranquille", "Goûter un cocktail que l'on ne connaît pas", "Finir par une petite balade"],
         "15 à 30 € · 1 h 30", "/img/verre.svg"),
        ("Découvrir un restaurant", "Une table qu'aucun des deux ne connaît encore, juste pour le plaisir de la découverte.",
         ["Cuisine d'un pays que l'on n'a jamais goûté", "Partager les plats", "Choisir le dessert à deux"],
         "25 à 50 € · 2 h", "/img/resto.svg"),
        ("Faire une promenade", "Marcher côte à côte, c'est souvent là que les meilleures conversations commencent.",
         ["Un sentier ou un parc avec de belles vues", "Un café à emporter pour la route", "S'arrêter où l'on veut"],
         "Gratuit · 1 h 30 à 2 h", "/img/promenade.svg"),
        ("Visiter un lieu culturel", "Une expo, un musée ou une galerie : de quoi se laisser surprendre et en reparler après.",
         ["Une exposition du moment", "Chacun choisit son œuvre préférée", "Débriefer autour d'un verre"],
         "5 à 15 € · 2 h", "/img/culture.svg"),
        ("Faire une activité originale", "Un atelier, un jeu, un truc un peu inattendu pour casser la routine du premier verre.",
         ["Atelier poterie ou cuisine", "Escape game, bowling ou mini-golf", "Un cours d'essai à deux"],
         "20 à 40 € · 2 h", "/img/originale.svg"),
        ("Une idée près de %s" % place, "Une adresse ou une activité propre à la région. À personnaliser avec une pépite locale.",
         ["Un marché ou un événement du moment", "Un point de vue incontournable", "Une spécialité locale à goûter"],
         "À préciser", "/img/local.svg"),
    ]
    return [
        dict(id=secrets.token_hex(4), title=t, description=d, todo=td, meta=m, image=img, active=True)
        for (t, d, td, m, img) in base
    ]


def new_invitation(name, host, region, welcome):
    return dict(
        id=secrets.token_hex(6), token=secrets.token_urlsafe(16), status="active",
        recipientName=name, hostName=host, region=region, welcomeMessage=welcome,
        ideas=default_ideas(region), responses=[], preference="", availability=[],
        createdAt=now(), updatedAt=now(),
    )


# ------------------------------------------------------------ validation ----
class ApiError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message


IMAGE_RE = re.compile(r"^(https?://\S+|/uploads/[\w.-]+|/img/[\w.-]+)$")
ANSWERS = ("liked", "maybe", "disliked")
SLOTS = ("semaine", "weekend", "journee", "soiree")


def text(data, key, maxlen, required=False, label=None):
    val = data.get(key, "")
    val = val.strip() if isinstance(val, str) else ""
    label = label or key
    if required and not val:
        raise ApiError(400, "Le champ « %s » est obligatoire." % label)
    if len(val) > maxlen:
        raise ApiError(400, "Le champ « %s » est trop long (%d caractères max)." % (label, maxlen))
    return val


def clean_invitation_fields(data):
    return dict(
        recipientName=text(data, "recipientName", 60, True, "Prénom"),
        hostName=text(data, "hostName", 60, True, "Ton prénom"),
        region=text(data, "region", 80, False, "Région"),
        welcomeMessage=text(data, "welcomeMessage", 300, False, "Message d'accueil") or DEFAULT_WELCOME,
    )


def clean_idea(data):
    todo = data.get("todo", [])
    if isinstance(todo, str):
        todo = todo.splitlines()
    if not isinstance(todo, list) or len(todo) > 12:
        raise ApiError(400, "Liste « À faire sur place » invalide (12 lignes max).")
    todo = [str(t).strip()[:120] for t in todo if str(t).strip()]
    image = text(data, "image", 500, False, "Image")
    if image and not IMAGE_RE.match(image):
        raise ApiError(400, "L'image doit être une URL http(s) ou un fichier envoyé.")
    return dict(
        title=text(data, "title", 80, True, "Titre"),
        description=text(data, "description", 400, True, "Description"),
        todo=todo,
        meta=text(data, "meta", 60, False, "Budget / durée"),
        image=image or "/img/local.svg",
        active=bool(data.get("active", True)),
    )


# --------------------------------------------------------- vues publiques ---
def public_view(inv):
    return dict(
        recipientName=inv["recipientName"], hostName=inv["hostName"], region=inv["region"],
        welcomeMessage=inv["welcomeMessage"],
        ideas=[i for i in inv["ideas"] if i["active"]],
        responses=inv["responses"], preference=inv["preference"], availability=inv["availability"],
    )


def stats(inv):
    counts = {a: 0 for a in ANSWERS}
    for r in inv["responses"]:
        counts[r["answer"]] = counts.get(r["answer"], 0) + 1
    return counts


def admin_view(inv):
    out = dict(inv)
    out["stats"] = stats(inv)
    return out


# -------------------------------------------------------------- sessions ----
def sign(value):
    return hmac.new(SECRET, value.encode(), hashlib.sha256).hexdigest()


def make_session():
    exp = str(int(time.time()) + SESSION_TTL)
    return exp + "." + sign(exp)


def valid_session(cookie_header):
    if not cookie_header:
        return False
    jar = cookies.SimpleCookie()
    try:
        jar.load(cookie_header)
    except cookies.CookieError:
        return False
    morsel = jar.get("pd_admin")
    if not morsel or "." not in morsel.value:
        return False
    exp, sig = morsel.value.split(".", 1)
    return exp.isdigit() and int(exp) > time.time() and hmac.compare_digest(sig, sign(exp))


LOGIN_FAILS = {}


def login_allowed(ip):
    fails = [t for t in LOGIN_FAILS.get(ip, []) if t > time.time() - 600]
    LOGIN_FAILS[ip] = fails
    return len(fails) < 8


# -------------------------------------------------------------- handlers ----
def get_invite(h, m, body):
    inv = load(token=m.group(1))
    if not inv:
        raise ApiError(404, "Invitation introuvable.")
    if inv["status"] != "active":
        raise ApiError(410, "Cette invitation est terminée.")
    return public_view(inv)


def active_by_token(token):
    inv = load(token=token)
    if not inv or inv["status"] != "active":
        raise ApiError(404, "Invitation introuvable.")
    return inv


def post_answer(h, m, body):
    inv = active_by_token(m.group(1))
    answer = body.get("answer")
    idea = next((i for i in inv["ideas"] if i["id"] == body.get("ideaId")), None)
    if answer not in ANSWERS or not idea:
        raise ApiError(400, "Réponse invalide.")
    inv["responses"] = [r for r in inv["responses"] if r["ideaId"] != idea["id"]]
    inv["responses"].append(dict(ideaId=idea["id"], ideaTitle=idea["title"], ideaImage=idea["image"],
                                 answer=answer, at=now()))
    save(inv)
    return dict(ok=True)


def post_preference(h, m, body):
    inv = active_by_token(m.group(1))
    inv["preference"] = text(body, "text", 1000, False, "Préférence")
    save(inv)
    return dict(ok=True)


def post_availability(h, m, body):
    inv = active_by_token(m.group(1))
    slots = body.get("slots", [])
    if not isinstance(slots, list) or any(s not in SLOTS for s in slots):
        raise ApiError(400, "Disponibilités invalides.")
    inv["availability"] = [s for s in SLOTS if s in slots]
    save(inv)
    return dict(ok=True)


def admin_login(h, m, body):
    ip = h.client_address[0]
    if not login_allowed(ip):
        raise ApiError(429, "Trop de tentatives, réessaie dans quelques minutes.")
    pwd = body.get("password", "")
    if not isinstance(pwd, str) or not hmac.compare_digest(pwd.encode(), ADMIN_PASSWORD.encode()):
        LOGIN_FAILS.setdefault(ip, []).append(time.time())
        raise ApiError(401, "Mot de passe incorrect.")
    flags = "; HttpOnly; SameSite=Strict; Path=/; Max-Age=%d" % SESSION_TTL
    if h.headers.get("X-Forwarded-Proto") == "https":
        flags += "; Secure"
    h.extra_headers.append(("Set-Cookie", "pd_admin=%s%s" % (make_session(), flags)))
    return dict(ok=True)


def admin_logout(h, m, body):
    h.extra_headers.append(("Set-Cookie", "pd_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"))
    return dict(ok=True)


def admin_list(h, m, body):
    return dict(invitations=[admin_view(i) for i in load_all()], defaults=dict(hostName=DEFAULT_HOST, welcomeMessage=DEFAULT_WELCOME))


def admin_create(h, m, body):
    fields = clean_invitation_fields(dict(body, hostName=body.get("hostName") or DEFAULT_HOST))
    with LOCK:
        for old in load_all():
            if old["status"] == "active":
                old["status"] = "archived"
                save(old)
        inv = new_invitation(fields["recipientName"], fields["hostName"], fields["region"], fields["welcomeMessage"])
        save(inv)
    return admin_view(inv)


def need_inv(inv_id):
    inv = load(inv_id=inv_id)
    if not inv:
        raise ApiError(404, "Invitation introuvable.")
    return inv


def admin_update(h, m, body):
    inv = need_inv(m.group(1))
    inv.update(clean_invitation_fields(body))
    return admin_view(save(inv))


def admin_archive(h, m, body):
    inv = need_inv(m.group(1))
    inv["status"] = "archived"
    return admin_view(save(inv))


def admin_delete(h, m, body):
    need_inv(m.group(1))
    delete_inv(m.group(1))
    return dict(ok=True)


def admin_idea_add(h, m, body):
    inv = need_inv(m.group(1))
    idea = dict(clean_idea(body), id=secrets.token_hex(4))
    inv["ideas"].append(idea)
    save(inv)
    return admin_view(inv)


def admin_idea_edit(h, m, body):
    inv = need_inv(m.group(1))
    idea = next((i for i in inv["ideas"] if i["id"] == m.group(2)), None)
    if not idea:
        raise ApiError(404, "Idée introuvable.")
    idea.update(clean_idea(body))
    save(inv)
    return admin_view(inv)


def admin_idea_delete(h, m, body):
    inv = need_inv(m.group(1))
    inv["ideas"] = [i for i in inv["ideas"] if i["id"] != m.group(2)]
    save(inv)
    return admin_view(inv)


UPLOAD_TYPES = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif"}


def admin_upload(h, m, body):
    match = re.match(r"^data:(image/[\w+.-]+);base64,(.+)$", body.get("dataUrl", ""), re.S)
    if not match or match.group(1) not in UPLOAD_TYPES:
        raise ApiError(400, "Format d'image non supporté (jpg, png, webp, gif).")
    try:
        raw = base64.b64decode(match.group(2), validate=True)
    except ValueError:
        raise ApiError(400, "Image illisible.")
    if len(raw) > 4 * 1024 * 1024:
        raise ApiError(413, "Image trop lourde (4 Mo max).")
    name = "%s.%s" % (secrets.token_hex(8), UPLOAD_TYPES[match.group(1)])
    (UPLOADS / name).write_bytes(raw)
    return dict(url="/uploads/" + name)


def admin_export(h, m, body):
    inv = need_inv(m.group(1))
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Idée", "Réponse", "Date"])
    labels = dict(liked="aimée", maybe="peut-être", disliked="refusée")
    for r in inv["responses"]:
        w.writerow([r["ideaTitle"], labels.get(r["answer"], r["answer"]), r["at"]])
    w.writerow([])
    w.writerow(["Préférence", inv["preference"]])
    w.writerow(["Disponibilités", ", ".join(inv["availability"])])
    return ("csv", "invitation-%s.csv" % re.sub(r"\W+", "-", inv["recipientName"].lower()), buf.getvalue())


# (méthode, regex, handler, admin ?)
ROUTES = [
    ("GET", r"^/api/invite/([\w-]+)$", get_invite, False),
    ("POST", r"^/api/invite/([\w-]+)/answer$", post_answer, False),
    ("POST", r"^/api/invite/([\w-]+)/preference$", post_preference, False),
    ("POST", r"^/api/invite/([\w-]+)/availability$", post_availability, False),
    ("POST", r"^/api/admin/login$", admin_login, False),
    ("POST", r"^/api/admin/logout$", admin_logout, False),
    ("GET", r"^/api/admin/invitations$", admin_list, True),
    ("POST", r"^/api/admin/invitations$", admin_create, True),
    ("PUT", r"^/api/admin/invitations/(\w+)$", admin_update, True),
    ("POST", r"^/api/admin/invitations/(\w+)/archive$", admin_archive, True),
    ("DELETE", r"^/api/admin/invitations/(\w+)$", admin_delete, True),
    ("GET", r"^/api/admin/invitations/(\w+)/export\.csv$", admin_export, True),
    ("POST", r"^/api/admin/invitations/(\w+)/ideas$", admin_idea_add, True),
    ("PUT", r"^/api/admin/invitations/(\w+)/ideas/(\w+)$", admin_idea_edit, True),
    ("DELETE", r"^/api/admin/invitations/(\w+)/ideas/(\w+)$", admin_idea_delete, True),
    ("POST", r"^/api/admin/upload$", admin_upload, True),
]
ROUTES = [(mth, re.compile(rx), fn, adm) for mth, rx, fn, adm in ROUTES]

SECURITY_HEADERS = [
    ("X-Content-Type-Options", "nosniff"),
    ("Referrer-Policy", "no-referrer"),
    ("X-Robots-Tag", "noindex, nofollow"),
]


class Handler(BaseHTTPRequestHandler):
    server_version = "LeProchainDate/1.0"

    def log_message(self, fmt, *args):
        pass

    def send_bytes(self, status, ctype, payload, extra=()):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(payload)))
        for k, v in SECURITY_HEADERS + list(extra) + self.extra_headers:
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)

    def send_json(self, status, obj):
        self.send_bytes(status, "application/json; charset=utf-8", json.dumps(obj, ensure_ascii=False).encode(),
                        [("Cache-Control", "no-store")])

    def handle_any(self):
        self.extra_headers = []
        path = urlparse(self.path).path
        try:
            if path.startswith("/api/"):
                return self.handle_api(path)
            if self.command not in ("GET", "HEAD"):
                raise ApiError(405, "Méthode non autorisée.")
            self.serve_static(path)
        except ApiError as e:
            self.send_json(e.status, dict(error=e.message))
        except Exception as e:  # noqa: BLE001
            print("Erreur :", repr(e))
            self.send_json(500, dict(error="Erreur interne."))

    def handle_api(self, path):
        for mth, rx, fn, admin in ROUTES:
            m = rx.match(path)
            if m and mth == self.command:
                if admin and not valid_session(self.headers.get("Cookie")):
                    raise ApiError(401, "Connexion requise.")
                body = {}
                if mth in ("POST", "PUT"):
                    length = int(self.headers.get("Content-Length") or 0)
                    if length > 7 * 1024 * 1024:
                        raise ApiError(413, "Requête trop volumineuse.")
                    if "application/json" not in (self.headers.get("Content-Type") or ""):
                        raise ApiError(415, "JSON attendu.")
                    try:
                        body = json.loads(self.rfile.read(length) or b"{}")
                    except ValueError:
                        raise ApiError(400, "JSON invalide.")
                    if not isinstance(body, dict):
                        raise ApiError(400, "JSON invalide.")
                result = fn(self, m, body)
                if isinstance(result, tuple) and result[0] == "csv":
                    return self.send_bytes(200, "text/csv; charset=utf-8", ("﻿" + result[2]).encode(),
                                           [("Content-Disposition", 'attachment; filename="%s"' % result[1])])
                return self.send_json(200, result)
        raise ApiError(404, "Introuvable.")

    def serve_static(self, path):
        if path == "/":
            return self.send_bytes(200, "text/html; charset=utf-8", PUBLIC.joinpath("home.html").read_bytes())
        if re.match(r"^/i/[\w-]+/?$", path):
            return self.send_bytes(200, "text/html; charset=utf-8", PUBLIC.joinpath("index.html").read_bytes(),
                                   [("Cache-Control", "no-store")])
        if path.rstrip("/") == "/admin":
            return self.send_bytes(200, "text/html; charset=utf-8", PUBLIC.joinpath("admin.html").read_bytes(),
                                   [("Cache-Control", "no-store")])
        base = UPLOADS if path.startswith("/uploads/") else PUBLIC
        rel = path[len("/uploads/"):] if base is UPLOADS else path.lstrip("/")
        target = (base / rel).resolve()
        if base not in target.parents or not target.is_file() or target.name.startswith("."):
            raise ApiError(404, "Introuvable.")
        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "image/svg+xml"):
            ctype += "; charset=utf-8"
        self.send_bytes(200, ctype, target.read_bytes(), [("Cache-Control", "no-cache" if target.suffix in (".js", ".css") else "public, max-age=300")])

    do_GET = do_POST = do_PUT = do_DELETE = do_HEAD = handle_any


if __name__ == "__main__":
    if ADMIN_PASSWORD == "changeme":
        print("⚠️  Mot de passe admin par défaut (« changeme »). Définis ADMIN_PASSWORD avant de mettre en ligne.")
    print("Le prochain date → http://localhost:%d   (admin : /admin)" % PORT)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
