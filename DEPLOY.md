# Mise en ligne : GitHub + Fly.io

## 1. GitHub (sauvegarde du code)
1. Crée un compte sur https://github.com (si besoin).
2. Installe **GitHub Desktop** : https://desktop.github.com, puis connecte-toi.
3. File > Add Local Repository > choisis `~/Documents/le-prochain-date`.
   Si l'app propose « create a repository », accepte.
4. Commit les fichiers (« Initial commit »), puis **Publish repository**
   et **coche « Keep this code private »**.

## 2. Fly.io (hébergement)
1. Crée un compte sur https://fly.io/app/sign-up (une carte bancaire est demandée, coût ~2–5 €/mois).
2. Installe l'outil en ligne de commande :
   ```bash
   curl -L https://fly.io/install.sh | sh
   ```
   Puis ajoute-le au terminal (copie les 2 lignes `export` affichées à la fin dans `~/.zshrc`) et ouvre un nouveau terminal.
3. Connexion :
   ```bash
   fly auth login
   ```
4. Dans le dossier du projet :
   ```bash
   cd ~/Documents/le-prochain-date
   fly launch --copy-config --no-deploy
   ```
   Réponds **non** à tout ce qui propose une base de données ou Redis. Garde la région Paris (cdg).
5. Crée le disque qui conservera la base (1 Go, même région) :
   ```bash
   fly volumes create data --size 1 --region cdg
   ```
6. Définis ton mot de passe admin (jamais dans le code) :
   ```bash
   fly secrets set ADMIN_PASSWORD="ton-mot-de-passe-solide"
   ```
7. Déploie, avec UNE seule machine (la base est sur un disque unique) :
   ```bash
   fly deploy --ha=false
   ```
8. Ouvre le site : `https://<nom-de-ton-app>.fly.dev/admin`

## 3. Mises à jour
Après un changement du code : `fly deploy --ha=false`.

## 4. Vérifications
- Connexion à `/admin`, création d'une invitation, test du lien sur ton iPhone.
- `fly apps restart` puis vérifie que les données sont toujours là.
