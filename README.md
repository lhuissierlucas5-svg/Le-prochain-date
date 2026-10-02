# Le prochain date

Site mobile-first pour envoyer une invitation personnalisée et recueillir des envies de rendez-vous (swipe).
Python 3.9+ uniquement, aucune dépendance. Données dans `data/` (SQLite + images envoyées).

```bash
ADMIN_PASSWORD="un-mot-de-passe-solide" python3 server.py
```

- Admin : http://localhost:8000/admin
- Lien invité : `/i/<jeton-unique>` (affiché et copiable dans l'admin)
- Variables : `PORT` (8000), `ADMIN_PASSWORD`, `HOST_NAME` (Lucas), `DATA_DIR` (./data)

## Fonctionnement
- Une seule invitation active : en créer une nouvelle archive l'ancienne (son lien renvoie « invitation terminée »).
- Chaque invitation a un jeton aléatoire ; le message d'accueil accepte `{name}`, `{host}`, `{region}`.
- Réponses : `liked` / `maybe` / `disliked`, enregistrées à chaque swipe ; préférence libre et disponibilités en fin de parcours.
- Export CSV des réponses depuis la page « Voir les réponses ».

## Structure
- `server.py` : API + fichiers statiques + auth admin (cookie signé HMAC, limitation des tentatives)
- `public/index.html` + `js/guest.js` : parcours invité · `public/admin.html` + `js/admin.js` : administration
- `public/img/*.svg` : illustrations par défaut (remplaçables par URL ou upload)

## Mise en ligne
Derrière HTTPS (Caddy, nginx, Render, Fly…) ; définir `ADMIN_PASSWORD`. Sans cette variable, le mot de passe par défaut est `changeme`.
