# FitMoi WhatsApp Server

Serveur WhatsApp pour l'application FitMoi de coaching perte de poids.

## Déploiement sur Railway

1. Créez un compte sur [Railway.app](https://railway.app)
2. Créez un nouveau projet
3. Connectez ce repo GitHub
4. Sélectionnez le dossier `whatsapp-server`
5. Railway va automatiquement détecter le Dockerfile et déployer

## Configuration

Aucune variable d'environnement requise. Le port est automatiquement configuré par Railway.

## Endpoints API

- `GET /health` - Health check
- `GET /status` - État de la connexion WhatsApp
- `GET /qr` - QR code pour connexion (si non connecté)
- `GET /groups` - Liste des groupes WhatsApp
- `GET /group-participants?groupId=xxx` - Participants d'un groupe
- `POST /select-group` - Sélectionner un groupe à suivre
- `POST /send-message` - Envoyer un message

## Note importante

La session WhatsApp est stockée localement. Sur Railway, elle sera perdue à chaque redéploiement.
Pour une solution plus robuste, envisagez d'utiliser un stockage persistant.
