# Utiliser une image Node avec Chromium préinstallé
FROM node:18-slim

# Installer les dépendances pour Puppeteer/Chromium
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    xdg-utils \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Définir les variables d'environnement pour Puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Créer le répertoire de travail
WORKDIR /app

# Copier les fichiers package
COPY package*.json ./

# Installer les dépendances
RUN npm install --production

# Copier le code source
COPY . .

# Créer le répertoire pour les sessions WhatsApp
RUN mkdir -p /app/whatsapp-session

# Exposer le port
EXPOSE 3001

# Démarrer le serveur
CMD ["node", "index.js"]
