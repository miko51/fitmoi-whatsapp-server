const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const http = require('http');
const url = require('url');
const fs = require('fs');

const PORT = process.env.PORT || 3001;
const isDocker = fs.existsSync('/.dockerenv') || process.env.RAILWAY_ENVIRONMENT;
const ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'https://fitmoi.vercel.app',
  'https://fitmoi-*.vercel.app'
];

// Configuration du webhook (où envoyer les messages pour analyse IA)
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://fitmoi.vercel.app/api/webhook/whatsapp';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'fitmoi-webhook-2024';

// État de la connexion
let clientReady = false;
let currentQR = null;
let currentQRBase64 = null;
let client = null;
let selectedGroupId = null;
let selectedGroupName = null;

// File d'attente pour les messages à envoyer au webhook
const messageQueue = [];
let isProcessingQueue = false;

// Initialiser le client WhatsApp
function initClient() {
  console.log('🚀 Démarrage du serveur WhatsApp FitMoi...\n');

  const puppeteerConfig = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu'
    ]
  };
  
  // Utiliser chromium système sur Docker/Railway
  if (isDocker) {
    puppeteerConfig.executablePath = '/usr/bin/chromium';
  }

  client = new Client({
    authStrategy: new LocalAuth({
      dataPath: isDocker ? '/tmp/whatsapp-session' : './whatsapp-session'
    }),
    puppeteer: puppeteerConfig
  });

  client.on('qr', async (qr) => {
    currentQR = qr;
    
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
    console.log('✅ WhatsApp connecté avec succès!\n');
    
    // Lister les groupes disponibles
    const chats = await client.getChats();
    const groups = chats.filter(chat => chat.isGroup);
    console.log(`📋 ${groups.length} groupes disponibles:\n`);
    groups.slice(0, 10).forEach((g, i) => {
      console.log(`  ${i + 1}. ${g.name} (${g.id._serialized})`);
    });
    if (groups.length > 10) {
      console.log(`  ... et ${groups.length - 10} autres groupes`);
    }
    
    console.log('\n👂 En écoute des messages...\n');
  });

  client.on('authenticated', () => {
    console.log('🔐 Authentification réussie!\n');
  });

  client.on('auth_failure', (msg) => {
    console.error('❌ Échec authentification:', msg);
    clientReady = false;
  });

  client.on('disconnected', (reason) => {
    console.log('📴 WhatsApp déconnecté:', reason);
    clientReady = false;
    currentQR = null;
    // Reconnecter après un délai
    setTimeout(() => {
      console.log('🔄 Tentative de reconnexion...');
      client.initialize();
    }, 5000);
  });

  client.on('message', async (msg) => {
    // Traiter uniquement les messages du groupe sélectionné
    if (selectedGroupId && msg.from === selectedGroupId) {
      try {
        // Récupérer les infos du contact
        const contact = await msg.getContact();
        const authorNumber = msg.author ? msg.author.split('@')[0] : msg.from.split('@')[0];
        
        console.log(`📩 Message de ${contact.pushname || authorNumber}: "${msg.body.substring(0, 50)}${msg.body.length > 50 ? '...' : ''}"`);
        
        // Préparer le message pour le webhook
        const messageData = {
          messageId: msg.id._serialized,
          groupId: selectedGroupId,
          groupName: selectedGroupName,
          from: authorNumber,
          fromName: contact.pushname || contact.name || null,
          body: msg.body,
          timestamp: msg.timestamp,
          hasMedia: msg.hasMedia,
          mediaUrl: null // TODO: gérer les médias si nécessaire
        };
        
        // Ajouter à la file d'attente
        messageQueue.push(messageData);
        processMessageQueue();
        
      } catch (err) {
        console.error('Erreur traitement message:', err.message);
      }
    }
  });

  client.initialize();
}

/**
 * Traite la file d'attente des messages et les envoie au webhook
 */
async function processMessageQueue() {
  if (isProcessingQueue || messageQueue.length === 0) return;
  
  isProcessingQueue = true;
  
  while (messageQueue.length > 0) {
    const message = messageQueue.shift();
    
    try {
      console.log(`🚀 Envoi au webhook: ${message.body.substring(0, 30)}...`);
      
      const response = await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${WEBHOOK_SECRET}`
        },
        body: JSON.stringify(message)
      });
      
      if (response.ok) {
        const result = await response.json();
        console.log(`✅ Analyse IA: ${result.analysis?.type || 'traité'} (confiance: ${result.analysis?.confidence || 'N/A'})`);
      } else {
        console.error(`❌ Erreur webhook: ${response.status}`);
        // Remettre en queue si erreur temporaire
        if (response.status >= 500) {
          messageQueue.unshift(message);
          await new Promise(r => setTimeout(r, 5000)); // Attendre 5s avant retry
        }
      }
    } catch (err) {
      console.error('❌ Erreur envoi webhook:', err.message);
      // Remettre en queue pour réessayer
      messageQueue.unshift(message);
      await new Promise(r => setTimeout(r, 5000));
    }
    
    // Petite pause entre les messages
    await new Promise(r => setTimeout(r, 100));
  }
  
  isProcessingQueue = false;
}

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
        selectedGroup: selectedGroupId
      }));
      return;
    }

    // GET /qr
    if (pathname === '/qr' && req.method === 'GET') {
      res.writeHead(200);
      res.end(JSON.stringify({
        qr: currentQR,
        qrBase64: currentQRBase64,
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
      
      const chats = await client.getChats();
      const groups = chats.filter(chat => chat.isGroup).map(g => ({
        id: g.id._serialized,
        name: g.name,
        participantsCount: g.participants?.length || 0
      }));
      
      res.writeHead(200);
      res.end(JSON.stringify(groups));
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
          
          const chat = await client.getChatById(groupId);
          selectedGroupName = chat.name;
          
          console.log(`\n✅ Groupe sélectionné: ${chat.name}`);
          console.log(`📡 Les messages seront envoyés au webhook: ${WEBHOOK_URL}`);
          console.log(`👂 En écoute des nouveaux messages...\n`);
          
          res.writeHead(200);
          res.end(JSON.stringify({ 
            success: true, 
            groupName: chat.name,
            webhookEnabled: true
          }));
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

// Démarrer le serveur
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n📡 API WhatsApp disponible sur le port ${PORT}`);
  console.log(`   - GET  /health        - Health check`);
  console.log(`   - GET  /status        - État de la connexion`);
  console.log(`   - GET  /qr            - QR code pour connexion`);
  console.log(`   - GET  /groups        - Liste des groupes`);
  console.log(`   - GET  /group-participants - Participants d'un groupe`);
  console.log(`   - POST /select-group  - Sélectionner un groupe`);
  console.log(`   - POST /send-message  - Envoyer un message\n`);
  
  initClient();
});
