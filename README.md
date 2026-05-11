# Scores Famille

Web app de scores de jeux de société, synchronisée via Google Drive. Stateless côté serveur — un seul fichier JSON dans ton Drive sert de base de données partagée.

## Contenu du dossier

- `index.html` — interface
- `style.css` — styles (mobile-first, dark/light auto)
- `app.js` — logique applicative
- `drive.js` — OAuth Google + Drive API + Picker
- `stats.js` — calculs de stats
- `seed.json` — données migrées du Google Sheet (54 parties Skyjo/6 Qui Prend/Sushi Go)

## Setup en 4 étapes

### 1. Créer un projet Google Cloud + OAuth Client ID

1. Va sur https://console.cloud.google.com — connecte-toi avec ton compte Google.
2. Crée un projet (bouton en haut, à côté du logo Google Cloud). Nom au choix, ex: `scores-famille`.
3. Active l'API Drive : APIs & Services → Library → cherche **Google Drive API** → Enable. Cherche aussi **Google Picker API** → Enable.
4. APIs & Services → OAuth consent screen :
   - User Type: **External**.
   - Remplis : nom de l'app `Scores Famille`, email de support (ton mail), email développeur (ton mail).
   - Scopes : laisse vide (les scopes sont demandés à la volée).
   - Test users : ajoute les emails Gmail de toute la famille (Titi, Steph, Guigui, etc.).
   - Save. Tu peux laisser l'app en mode "Testing" — pas besoin de publier (limite : 100 utilisateurs, on est largement sous).
5. APIs & Services → Credentials → Create Credentials → **OAuth client ID** :
   - Type : **Web application**.
   - Authorized JavaScript origins : ajoute l'URL où sera hébergée l'app (ex: `https://magnier-guillaume.github.io`). Ajoute aussi `http://localhost:8080` pour tests locaux.
   - Pas besoin de redirect URIs (on utilise GIS, pas le flow redirect).
   - Save. Copie le **Client ID** (format `xxxxx.apps.googleusercontent.com`).

### 2. Déployer sur GitHub Pages

1. Crée un repo GitHub public (ou privé avec Pages activé).
2. Pousse les 6 fichiers (`index.html`, `style.css`, `app.js`, `drive.js`, `stats.js`, `seed.json`).
3. Settings → Pages → Source : `main` branch / `/ (root)` → Save.
4. Note l'URL générée (ex: `https://magnier-guillaume.github.io/scores-famille/`).
5. Retourne sur Google Cloud Console → ton OAuth Client ID → ajoute cette URL exacte dans "Authorized JavaScript origins" (sans slash final) → Save.

Alternative locale rapide pour test : `python3 -m http.server 8080` dans le dossier, puis `http://localhost:8080`.

### 3. Premier lancement (toi, Guillaume)

1. Ouvre l'URL GitHub Pages.
2. Colle ton Client ID dans le champ et Enregistre.
3. Clique "Se connecter avec Google", autorise les permissions Drive.
4. Choisis **"Créer + importer l'ancien Sheet (54 parties)"** → l'app crée `scores-famille-db.json` dans ton Drive et y importe les 54 parties historiques.
5. Va dans ton Drive Google, retrouve le fichier `scores-famille-db.json` (recherche par nom), clic droit → **Partager** → ajoute les emails Gmail de la famille en **Éditeur**.

### 4. Setup des autres joueurs (Titi, Steph, etc.)

1. Tu leur envoies l'URL de l'app + le Client ID.
2. Ils ouvrent l'URL, collent le Client ID, se connectent avec leur Google.
3. L'app ne trouve pas le fichier automatiquement (sécurité du scope `drive.file`). Elle propose **"Sélectionner une base partagée (Picker)"**.
4. Le Google Picker s'ouvre, ils choisissent `scores-famille-db.json` partagé par toi → c'est fait, accès permanent depuis cet appareil.

> Le scope `drive.file` est volontairement restrictif : l'app ne voit que les fichiers que l'utilisateur a créés ou explicitement ouverts via Picker. Aucun accès à ton Drive entier.

## Utilisation

- **Nouvelle partie** : bouton sur la page d'accueil. Choisis le jeu, sélectionne les joueurs (chips cliquables), démarre.
- **Saisie d'un tour** : verrou par tour. Quand quelqu'un clique "Saisir tour #X", les autres voient "🔒 X est en train de saisir (libère dans Ns)". Au bout de 30s sans validation, n'importe qui peut forcer la libération. Validation : Entrée ou bouton.
- **Fin de partie auto** : selon la règle du jeu (seuil Skyjo 100 / 6 Qui Prend 66, manches Sushi Go, manuel Skip-Bo). Le vainqueur s'affiche en bandeau.
- **Stats** : filtres par jeu et période. KPI, classement, podium par jeu, face-à-face V-N-D, courbe d'évolution (visible quand on filtre sur un jeu).
- **Historique** : toutes les parties terminées, cliquables pour revoir les tours.

## Synchro

- Polling Drive toutes les 2.5 s pendant une partie active, 10 s sinon.
- En cas d'écriture concurrente, l'app refetch + fusionne + réécrit automatiquement. Latence typique : 2–5 s entre la saisie sur un appareil et l'apparition sur les autres.
- Stratégie de merge : union pour joueurs/jeux/parties ; pour les tours, la dernière saisie (timestamp) gagne par (matchId, n).

## Ajouter un nouveau jeu

Onglet **Jeux** → formulaire en bas. Choisis nom, sens (bas/haut gagne), condition de fin (seuil / nb manches / manuel).

## Sauvegarde / récupération

Le fichier `scores-famille-db.json` dans ton Drive est la seule source. Tu peux le télécharger pour backup à tout moment. Versions Drive disponibles via clic droit → "Versions précédentes" (Drive garde l'historique 30 jours).

## Limites connues

- Pas d'offline complet : si Drive est inaccessible, les saisies récentes restent en mémoire mais ne se synchronisent qu'au retour réseau.
- Pas de notifications push : seule la synchro par polling.
- Picker : un invité doit refaire la sélection sur chaque nouveau navigateur/appareil (une seule fois par device).

## Migration depuis le Sheet original

Déjà faite dans `seed.json` à partir de `Scores.xlsx` :
- 54 parties (27 Skyjo, 17 6 Qui Prend, 10 Sushi Go, 0 Skip-Bo vide dans le Sheet)
- 194 tours
- 3 joueurs historiques (Titi, Steph, Guigui) + 10 autres joueurs créés mais sans historique (dont Guillaume)
- Dates manquantes → toutes au 01/01/2026 comme convenu

Si tu veux ré-importer un Sheet à jour plus tard : modifie `seed.json` ou écrase le fichier `scores-famille-db.json` dans Drive.
