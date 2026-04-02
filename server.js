const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Store active sessions
const sessions = new Map();
const messageStats = new Map();

// Helper: generate random delay
const randomDelay = (min, max) => Math.floor(Math.random() * (max - min + 1) + min);

// Helper: format number to WhatsApp ID
const formatNumber = (number) => {
  let clean = number.toString().replace(/\D/g, '');
  if (!clean.endsWith('@c.us')) {
    clean = clean + '@c.us';
  }
  return clean;
};

// Create WhatsApp client
function createClient(sessionId, io, socketId) {
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: sessionId }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    }
  });

  client.on('qr', async (qr) => {
    const qrImage = await QRCode.toDataURL(qr);
    io.to(socketId).emit('qr', { sessionId, qr: qrImage });
  });

  client.on('ready', () => {
    io.to(socketId).emit('ready', { sessionId, message: 'WhatsApp Connected!' });
    if (!messageStats.has(sessionId)) {
      messageStats.set(sessionId, { totalSent: 0, history: [] });
    }
  });

  client.on('authenticated', () => {
    io.to(socketId).emit('authenticated', { sessionId });
  });

  client.on('auth_failure', (msg) => {
    io.to(socketId).emit('error', { sessionId, message: 'Auth failed: ' + msg });
  });

  client.on('disconnected', (reason) => {
    sessions.delete(sessionId);
    io.to(socketId).emit('disconnected', { sessionId, message: 'Disconnected: ' + reason });
  });

  client.initialize();
  return client;
}

// Socket.IO connection
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('connect-wa', async ({ sessionId }) => {
    if (sessions.has(sessionId)) {
      socket.emit('ready', { sessionId, message: 'Already connected' });
      return;
    }
    const client = createClient(sessionId, io, socket.id);
    sessions.set(sessionId, { client, socketId: socket.id });
  });

  socket.on('disconnect-wa', ({ sessionId }) => {
    const session = sessions.get(sessionId);
    if (session && session.client) {
      session.client.destroy();
      sessions.delete(sessionId);
      socket.emit('disconnected', { sessionId, message: 'Disconnected manually' });
    }
  });

  socket.on('start-warming', async ({ sessionId, contacts, texts, delayMin, delayMax, mode }) => {
    const session = sessions.get(sessionId);
    if (!session || !session.client) {
      socket.emit('error', { message: 'WhatsApp not connected!' });
      return;
    }

    const client = session.client;
    const stats = messageStats.get(sessionId) || { totalSent: 0, history: [] };
    
    socket.emit('warming-started', { sessionId, message: 'Warming started!' });

    for (const contact of contacts) {
      if (!contact || contact.trim() === '') continue;
      
      let messageToSend = '';
      if (mode === 'random') {
        const randomIndex = Math.floor(Math.random() * texts.length);
        messageToSend = texts[randomIndex];
      } else {
        for (let i = 0; i < texts.length; i++) {
          messageToSend = texts[i];
          
          try {
            const formattedNumber = formatNumber(contact);
            await client.sendMessage(formattedNumber, messageToSend);
            
            stats.totalSent++;
            stats.history.push({
              contact,
              message: messageToSend.substring(0, 50),
              time: new Date().toISOString()
            });
            
            if (stats.history.length > 100) stats.history.shift();
            messageStats.set(sessionId, stats);
            
            io.to(session.socketId).emit('stats-update', {
              totalSent: stats.totalSent,
              lastMessage: { contact, message: messageToSend, time: new Date().toISOString() }
            });
            
            const delay = randomDelay(delayMin, delayMax);
            await new Promise(resolve => setTimeout(resolve, delay));
            
          } catch (error) {
            socket.emit('error', { message: `Failed to send to ${contact}: ${error.message}` });
          }
        }
      }
      
      if (mode === 'random') {
        try {
          const formattedNumber = formatNumber(contact);
          await client.sendMessage(formattedNumber, messageToSend);
          
          stats.totalSent++;
          stats.history.push({
            contact,
            message: messageToSend.substring(0, 50),
            time: new Date().toISOString()
          });
          
          if (stats.history.length > 100) stats.history.shift();
          messageStats.set(sessionId, stats);
          
          io.to(session.socketId).emit('stats-update', {
            totalSent: stats.totalSent,
            lastMessage: { contact, message: messageToSend, time: new Date().toISOString() }
          });
          
          const delay = randomDelay(delayMin, delayMax);
          await new Promise(resolve => setTimeout(resolve, delay));
          
        } catch (error) {
          socket.emit('error', { message: `Failed to send to ${contact}: ${error.message}` });
        }
      }
    }
    
    socket.emit('warming-completed', { sessionId, totalSent: stats.totalSent });
  });

  socket.on('get-stats', ({ sessionId }) => {
    const stats = messageStats.get(sessionId) || { totalSent: 0, history: [] };
    socket.emit('stats-data', stats);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', sessions: sessions.size, timestamp: Date.now() });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 WhatsApp Warmer running on port ${PORT}`);
});