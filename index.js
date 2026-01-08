const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const http = require('http');
const url = require('url');

const PORT = process.env.PORT || 3001;
const ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'https://fitmoi.vercel.app',
  'https://fitmoi-*.vercel.app'
];

// État de la connexion
let clientReady = false;
let currentQR = null;
let currentQRBase64 = null;
let client = null;
let selectedGroupId = null;
let initializationError = null;

// Vérifier si l'origine est autorisée
function isOriginAllowed(origin) {
  if (!origin) return true;
  return ALLOWED_ORIGINS.some(allowed => {
    if (allowed.includes('*')) {
      const pattern = allowed.replace('*', '.*');
      return new RegExp(pattern).test(origin);
    }
    return allowed === origin;
  });
}

// Créer le serveur HTTP
const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  
  // CORS headers
  if (isOriginAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  // Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  try {
    // GET /health - Health check pour Railway
    if (pathname === '/health' || pathname === '/') {
      res.writeHead(200);
      res.end(JSON.stringify({ 
        status: 'ok', 
        connected: clientReady,
        hasQR: currentQR !== null,
        error: initializationError,
        timestamp: new Date().toISOString()
      }));
      return;
    }

    // GET /status
    if (pathname === '/status' && req.method === 'GET') {
      res.writeHead(200);
      res.end(JSON.stringify({
        connected: clientReady,
        hasQR: currentQR !== null,
        selectedGroup: selectedGroupId,
        error: initializationError
      }));
      return;
    }

    // GET /qr
    if (pathname === '/qr' && req.method === 'GET') {
      res.writeHead(200);
      res.end(JSON.stringify({
        qr: currentQRBase64,
        qrRaw: currentQR,
        connected: clientReady
      }));
      return;
    }

    // GET /groups
    if (pathname === '/groups' && req.method === 'GET') {
      if (!clientReady) {
        res.writeHead(503);
        res.end(JSON.stringify({ error: 'WhatsApp non connecté' }));
        return;
      }
      
      // Paramètre optionnel pour filtrer par mot-clé
      const keyword = parsedUrl.query.keyword?.toLowerCase();
      const limit = parseInt(parsedUrl.query.limit) || 50;
      
      const chats = await client.getChats();
      let groups = chats.filter(chat => chat.isGroup);
      
      // Filtrer par mot-clé si fourni
      if (keyword) {
        groups = groups.filter(g => g.name.toLowerCase().includes(keyword));
      }
      
      // Limiter le nombre de résultats
      const result = groups.slice(0, limit).map(g => ({
        id: g.id._serialized,
        name: g.name,
        participantsCount: g.participants?.length || 0
      }));
      
      console.log(`📋 ${result.length} groupes trouvés${keyword ? ` (filtre: "${keyword}")` : ''}`);
      
      res.writeHead(200);
      res.end(JSON.stringify(result));
      return;
    }

    // GET /group-participants
    if (pathname === '/group-participants' && req.method === 'GET') {
      if (!clientReady) {
        res.writeHead(503);
        res.end(JSON.stringify({ error: 'WhatsApp non connecté' }));
        return;
      }
      
      const groupId = parsedUrl.query.groupId;
      if (!groupId) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'groupId requis' }));
        return;
      }
      
      const chat = await client.getChatById(groupId);
      if (!chat.isGroup) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Ce n\'est pas un groupe' }));
        return;
      }
      
      const participants = [];
      for (const participant of chat.participants) {
        try {
          const contact = await client.getContactById(participant.id._serialized);
          participants.push({
            id: participant.id._serialized,
            phoneNumber: participant.id.user,
            name: contact.pushname || contact.name || null,
            isAdmin: participant.isAdmin || participant.isSuperAdmin || false
          });
        } catch (err) {
          participants.push({
            id: participant.id._serialized,
            phoneNumber: participant.id.user,
            name: null,
            isAdmin: participant.isAdmin || participant.isSuperAdmin || false
          });
        }
      }
      
      res.writeHead(200);
      res.end(JSON.stringify({
        groupId: groupId,
        groupName: chat.name,
        participants: participants
      }));
      return;
    }

    // POST /select-group
    if (pathname === '/select-group' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const { groupId } = JSON.parse(body);
          selectedGroupId = groupId;
          
          if (clientReady) {
            const chat = await client.getChatById(groupId);
            console.log(`✅ Groupe sélectionné: ${chat.name}`);
            res.writeHead(200);
            res.end(JSON.stringify({ 
              success: true, 
              groupName: chat.name 
            }));
          } else {
            res.writeHead(200);
            res.end(JSON.stringify({ 
              success: true, 
              groupName: 'WhatsApp non connecté' 
            }));
          }
        } catch (err) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // POST /send-message
    if (pathname === '/send-message' && req.method === 'POST') {
      if (!clientReady) {
        res.writeHead(503);
        res.end(JSON.stringify({ error: 'WhatsApp non connecté' }));
        return;
      }

      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const { to, message } = JSON.parse(body);
          
          // Formater le numéro
          let chatId = to;
          if (!to.includes('@')) {
            chatId = to.replace(/\D/g, '') + '@c.us';
          }
          
          await client.sendMessage(chatId, message);
          console.log(`📤 Message envoyé à ${chatId}`);
          
          res.writeHead(200);
          res.end(JSON.stringify({ success: true }));
        } catch (err) {
          console.error('Erreur envoi message:', err);
          res.writeHead(500);
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // 404
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Route non trouvée' }));

  } catch (err) {
    console.error('Erreur serveur:', err);
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  }
});

// Initialiser le client WhatsApp
function initClient() {
  console.log('🚀 Initialisation du client WhatsApp...\n');

  try {
    // Déterminer le chemin de Chromium
    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';
    console.log(`📍 Chromium path: ${executablePath}`);

    client = new Client({
      authStrategy: new LocalAuth({
        dataPath: '/tmp/whatsapp-session'
      }),
      puppeteer: {
        headless: true,
        executablePath: executablePath,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--single-process',
          '--disable-gpu',
          '--disable-extensions',
          '--disable-software-rasterizer'
        ]
      }
    });

    client.on('qr', async (qr) => {
      currentQR = qr;
      initializationError = null;
      
      // Générer le QR code en base64 pour l'API
      try {
        currentQRBase64 = await QRCode.toDataURL(qr, { 
          width: 256,
          margin: 2,
          color: { dark: '#000000', light: '#ffffff' }
        });
        console.log('✅ QR Code base64 généré');
      } catch (err) {
        console.error('Erreur génération QR base64:', err);
      }
      
      console.log('\n📱 QR Code reçu! Scannez-le avec WhatsApp:\n');
      qrcodeTerminal.generate(qr, { small: true });
      console.log('\n⏳ En attente du scan...\n');
    });

    client.on('ready', async () => {
      clientReady = true;
      currentQR = null;
      currentQRBase64 = null;
      initializationError = null;
      console.log('✅ WhatsApp connecté avec succès!\n');
      
      try {
        const chats = await client.getChats();
        const groups = chats.filter(chat => chat.isGroup);
        console.log(`📋 ${groups.length} groupes disponibles:\n`);
        groups.slice(0, 10).forEach((g, i) => {
          console.log(`  ${i + 1}. ${g.name} (${g.id._serialized})`);
        });
        if (groups.length > 10) {
          console.log(`  ... et ${groups.length - 10} autres groupes`);
        }
      } catch (err) {
        console.log('Erreur listing groupes:', err.message);
      }
      
      console.log('\n👂 En écoute des messages...\n');
    });

    client.on('authenticated', () => {
      console.log('🔐 Authentification réussie!\n');
    });

    client.on('auth_failure', (msg) => {
      console.error('❌ Échec authentification:', msg);
      clientReady = false;
      initializationError = 'Échec authentification: ' + msg;
    });

    client.on('disconnected', (reason) => {
      console.log('📴 WhatsApp déconnecté:', reason);
      clientReady = false;
      currentQR = null;
      // Reconnecter après un délai
      setTimeout(() => {
        console.log('🔄 Tentative de reconnexion...');
        client.initialize().catch(err => {
          console.error('Erreur reconnexion:', err.message);
        });
      }, 10000);
    });

    client.on('message', async (msg) => {
      if (selectedGroupId && msg.from === selectedGroupId) {
        console.log(`📩 Message de ${msg.from}: ${msg.body.substring(0, 50)}...`);
      }
    });

    console.log('🔄 Démarrage de WhatsApp Web...');
    client.initialize().catch(err => {
      console.error('❌ Erreur initialisation WhatsApp:', err.message);
      initializationError = err.message;
    });

  } catch (err) {
    console.error('❌ Erreur création client:', err.message);
    initializationError = err.message;
  }
}

// Démarrer le serveur HTTP d'abord
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n📡 Serveur HTTP démarré sur le port ${PORT}`);
  console.log(`   - GET  /health        - Health check`);
  console.log(`   - GET  /status        - État de la connexion`);
  console.log(`   - GET  /qr            - QR code pour connexion`);
  console.log(`   - GET  /groups        - Liste des groupes`);
  console.log(`   - GET  /group-participants - Participants d'un groupe`);
  console.log(`   - POST /select-group  - Sélectionner un groupe`);
  console.log(`   - POST /send-message  - Envoyer un message\n`);
  
  // Initialiser WhatsApp après un court délai
  setTimeout(() => {
    initClient();
  }, 2000);
});
