require('dotenv').config();
const express = require('express');
const path = require('path');
const { Client } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');

// === CONFIGURACIÓN INICIAL ===
const app = express();
const port = process.env.PORT || 3456;
console.log("==================================================");
console.log(`INICIANDO SERVIDOR EN PUERTO ${port} - ${new Date().toLocaleTimeString()}`);
console.log("==================================================");

// Archivos de persistencia
const RULES_FILE = 'rules.json';
const GEMINI_STARTERS_FILE = 'gemini-starters.json';

// Función para cargar datos desde archivo
function loadData(filename, defaultValue = []) {
    try {
        if (fs.existsSync(filename)) {
            const data = fs.readFileSync(filename, 'utf8');
            return JSON.parse(data);
        }
    } catch (error) {
        console.error(`Error cargando ${filename}:`, error);
    }
    return defaultValue;
}

// Función para guardar datos en archivo
function saveData(filename, data) {
    try {
        fs.writeFileSync(filename, JSON.stringify(data, null, 2));
        return true;
    } catch (error) {
        console.error(`Error guardando ${filename}:`, error);
        return false;
    }
}

// Cargar datos persistentes
let autoReplyRules = loadData(RULES_FILE);
let geminiConversationStarters = loadData(GEMINI_STARTERS_FILE);

// --- Validar Clave API de Gemini ---
const geminiApiKey = process.env.GEMINI_API_KEY;
if (!geminiApiKey) {
  console.error('ERROR CRÍTICO: La variable de entorno GEMINI_API_KEY no está definida.');
  process.exit(1);
}

// --- Middlewares ---
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// --- Middleware para loggear todas las peticiones ---
app.use((req, res, next) => {
    console.log(`${req.method} ${req.url} - ${new Date().toLocaleTimeString()}`);
    next();
});

// --- Inicializaciones de Clientes y Variables Globales ---
const client = new Client({
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        headless: true
    }
});
console.log(">>> Cliente WhatsApp configurado con opciones personalizadas");

const genAI = new GoogleGenerativeAI(geminiApiKey);
const geminiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash"});

let qrCodeUrl = null;
let clientReady = false;
let messagesLog = [];
let activeAiConversations = {}; // Conversaciones activas { senderId: prompt }

// === EVENTOS DEL CLIENTE WHATSAPP ===
client.on('qr', async (qr) => {
    console.log(">>> QR RECIBIDO! Intentando generar imagen...");
    try {
        qrCodeUrl = await qrcode.toDataURL(qr);
        console.log(">>> QR generado con éxito, longitud:", qrCodeUrl.length);
    } catch (err) {
        console.error(">>> ERROR GENERANDO QR:", err);
        qrCodeUrl = null;
    }
});

client.on('ready', () => {
    console.log(">>> CLIENTE WHATSAPP LISTO!");
    clientReady = true;
    qrCodeUrl = null;
});

client.on('authenticated', () => {
    console.log('>>> CLIENTE AUTENTICADO!');
});

// Lógica de procesamiento de mensajes
client.on('message', async (message) => {
  const sender = message.from;
  const body = message.body;
  const isFromMe = message.fromMe;
  const isGroup = message.id.remote.endsWith('@g.us');

  if (isFromMe || isGroup) return;

  console.log(`[DEBUG] Mensaje recibido de ${sender}: "${body}"`);
  messagesLog.push({ from: sender, body: body, timestamp: new Date().toLocaleTimeString() });
  if (messagesLog.length > 100) messagesLog.shift();

  try {
    // 1. ¿Conversación IA activa?
    if (activeAiConversations[sender]) {
        const assignedPrompt = activeAiConversations[sender];
        console.log(`[AI Conv Activa] para ${sender}. Generando respuesta...`);
        
        // Construir el contexto de la conversación
        const conversationContext = messagesLog
            .filter(msg => msg.from === sender || msg.to === sender)
            .slice(-5) // Últimos 5 mensajes para contexto
            .map(msg => {
                if (msg.from === sender) {
                    return `Usuario: ${msg.body}`;
                } else {
                    return `IA: ${msg.body}`;
                }
            })
            .join('\n');

        const conversationPrompt = `${assignedPrompt}\n\n---\nHistorial de la conversación:\n${conversationContext}\n\n---\nMensaje más reciente:\nUsuario: ${body}\n\n---\nTu Respuesta (continúa la conversación de manera natural y coherente):`;
        
        console.log(`[DEBUG] Prompt enviado a Gemini:\n${conversationPrompt}`);
        
        const result = await geminiModel.generateContent(conversationPrompt);
        const geminiResponse = await result.response.text();
        
        if (geminiResponse) {
            console.log(`[AI Conv Activa] Respuesta Gemini: ${geminiResponse}`);
            await client.sendMessage(sender, geminiResponse);
            messagesLog.push({ from: 'me (IA-Conv)', to: sender, body: geminiResponse, timestamp: new Date().toLocaleTimeString() });
        } else {
            console.log(`[AI Conv Activa] Gemini no generó respuesta.`);
        }
        return;
    }

    // 2. ¿Nuevo disparador de conversación IA?
    const matchedStarter = geminiConversationStarters.find(starter => {
        const messageText = body.trim().toLowerCase();
        const triggerText = starter.trigger.trim().toLowerCase();
        console.log(`[DEBUG] Comparando mensaje: "${messageText}" con trigger: "${triggerText}"`);
        const matches = messageText.includes(triggerText) || messageText === triggerText;
        console.log(`[DEBUG] ¿Coincide? ${matches}`);
        return matches;
    });

    if (matchedStarter) {
        console.log(`[AI Starter] para ${sender} con trigger "${matchedStarter.trigger}".`);
        activeAiConversations[sender] = matchedStarter.prompt;
        console.log(`   -> Prompt asignado: "${matchedStarter.prompt}"`);
        
        const firstResponsePrompt = `${matchedStarter.prompt}\n\n---\nAcabas de recibir este primer mensaje que inició la conversación:\nUsuario: ${body}\n\n---\nTu Primera Respuesta (inicia la conversación de manera natural y amigable):`;
        
        console.log(`[DEBUG] Primer prompt enviado a Gemini:\n${firstResponsePrompt}`);
        
        const result = await geminiModel.generateContent(firstResponsePrompt);
        const geminiResponse = await result.response.text();
        
        if (geminiResponse) {
            console.log(`[AI Starter] Primera respuesta Gemini: ${geminiResponse}`);
            await client.sendMessage(sender, geminiResponse);
            messagesLog.push({ from: 'me (IA-Starter)', to: sender, body: geminiResponse, timestamp: new Date().toLocaleTimeString() });
        } else {
            console.log(`[AI Starter] Gemini no generó primera respuesta.`);
        }
        return;
    }

    // 3. ¿Regla simple?
    const matchingSimpleRule = autoReplyRules.find(rule => {
        const messageText = body.trim().toLowerCase();
        const triggerText = rule.trigger.trim().toLowerCase();
        console.log(`[DEBUG] Comparando mensaje: "${messageText}" con trigger: "${triggerText}"`);
        const matches = messageText.includes(triggerText) || messageText === triggerText;
        console.log(`[DEBUG] ¿Coincide? ${matches}`);
        return matches;
    });

    if (matchingSimpleRule) {
        console.log(`[Simple Rule] para ${sender}: ${matchingSimpleRule.response}`);
        await client.sendMessage(sender, matchingSimpleRule.response);
        messagesLog.push({ from: 'me (auto-simple)', to: sender, body: matchingSimpleRule.response, timestamp: new Date().toLocaleTimeString() });
        return;
    }

    console.log(`[DEBUG] Mensaje de ${sender} no coincide con ninguna regla.`);

  } catch (error) {
      console.error(`Error procesando mensaje de ${sender}:`, error);
  }
});

client.on('disconnected', (reason) => {
  console.log('Client was logged out', reason);
  clientReady = false;
  qrCodeUrl = null;
  activeAiConversations = {}; // Limpiar al desconectar
});

// === RUTAS DE LA API ===

// --- Rutas de estado y diagnóstico ---
app.get('/', (req, res) => {
    console.log('>>> Petición a / (raíz) recibida');
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/test', (req, res) => {
    console.log('>>> Petición a /test recibida');
    res.send('¡Servidor funcionando correctamente!');
});

app.get('/status', (req, res) => { 
    console.log('>>> GET /status');
    res.json({ qrCodeUrl, clientReady }); 
});

// --- Rutas para mensajes ---
app.get('/messages', (req, res) => { 
    console.log('>>> GET /messages');
    res.json(messagesLog); 
});

app.post('/send-message', async (req, res) => {
    console.log('>>> POST /send-message:', req.body);
    if (!clientReady) {
        return res.status(400).json({ success: false, message: 'Cliente WhatsApp no está listo' });
    }
    try {
        const { number, message } = req.body;
        if (!number || !message) {
            return res.status(400).json({ success: false, message: 'Número y mensaje son requeridos' });
        }
        const chatId = number.includes('@') ? number : `${number}@c.us`;
        await client.sendMessage(chatId, message);
        messagesLog.push({ from: 'me (manual)', to: chatId, body: message, timestamp: new Date().toLocaleTimeString() });
        res.json({ success: true, message: 'Mensaje enviado con éxito' });
    } catch (error) {
        console.error('Error enviando mensaje:', error);
        res.status(500).json({ success: false, message: 'Error enviando mensaje', error: error.message });
    }
});

// --- Iniciar Conversación Manualmente con IA ---
app.post('/initiate-conversation', async (req, res) => {
    console.log('>>> Petición POST a /initiate-conversation recibida con body:', req.body);
    if (!clientReady) {
        return res.status(400).json({ success: false, message: 'El cliente de WhatsApp no está listo.' });
    }
    const { number, promptForOpeningMessage } = req.body;
    if (!number || !promptForOpeningMessage) {
        return res.status(400).json({ success: false, message: 'Número y prompt son requeridos.' });
    }
    const chatId = number.includes('@') ? number : `${number}@c.us`;
    try {
        console.log(`Pidiendo a Gemini que genere mensaje de apertura para ${chatId} basado en: "${promptForOpeningMessage}"`);
        const generationPrompt = `Basado en la siguiente instrucción, genera un mensaje corto y natural para INICIAR una conversación de WhatsApp. Sé directo y amigable. No incluyas saludos genéricos como 'Hola' si la instrucción ya implica un contexto. \n\nInstrucción: "${promptForOpeningMessage}"\n\nMensaje de WhatsApp:`;
        const result = await geminiModel.generateContent(generationPrompt);
        const openingMessage = await result.response.text();
        if (!openingMessage) {
            console.error('Gemini no generó un mensaje de apertura.');
            return res.status(500).json({ success: false, message: 'Gemini no pudo generar un mensaje de apertura.' });
        }
        console.log(`Mensaje de apertura generado por Gemini: "${openingMessage}"`);
        console.log(`Enviando mensaje de apertura a ${chatId}`);
        await client.sendMessage(chatId, openingMessage);
        console.log('Mensaje de apertura enviado con éxito.');
        messagesLog.push({ 
            from: 'me (IA-initiator)', 
            to: chatId, 
            body: openingMessage, 
            prompt: promptForOpeningMessage,
            timestamp: new Date().toLocaleTimeString() 
        });
        res.json({ success: true, message: 'Mensaje de apertura enviado con éxito.', openingMessage });
    } catch (error) {
        console.error('Error iniciando conversación con IA:', error);
        res.status(500).json({ success: false, message: 'Error iniciando conversación con IA.', error: error.message });
    }
});

// --- Endpoints para Reglas Simples ---
app.get('/rules', (req, res) => { 
    console.log('>>> GET /rules');
    res.json(autoReplyRules); 
});

app.post('/add-rule', (req, res) => {
    console.log('>>> POST /add-rule:', req.body);
    const { trigger, response } = req.body;
    if (!trigger || !response) {
        return res.status(400).json({ success: false, message: 'Trigger y response son requeridos.' });
    }
    
    // Verificar si ya existe un trigger con este nombre
    if (autoReplyRules.find(rule => rule.trigger.toLowerCase() === trigger.toLowerCase())) {
        return res.status(400).json({ success: false, message: 'Ya existe una regla con este trigger.' });
    }
    
    const newRule = { trigger, response };
    autoReplyRules.push(newRule);
    saveData(RULES_FILE, autoReplyRules);
    console.log('Regla añadida:', newRule);
    res.json({ success: true, rule: newRule });
});

app.delete('/delete-rule/:trigger', (req, res) => {
    const triggerToDelete = decodeURIComponent(req.params.trigger);
    console.log(`>>> DELETE /delete-rule/${triggerToDelete}`);
    
    const initialLength = autoReplyRules.length;
    autoReplyRules = autoReplyRules.filter(rule => 
        rule.trigger.toLowerCase() !== triggerToDelete.toLowerCase()
    );
    
    if (autoReplyRules.length < initialLength) {
        saveData(RULES_FILE, autoReplyRules);
        res.json({ success: true, message: 'Regla eliminada.' });
    } else {
        res.status(404).json({ success: false, message: 'Regla no encontrada.' });
    }
});

// --- Endpoints para Disparadores Gemini ---
console.log("*** Registrando endpoints para /gemini-starters... ***");
app.get('/gemini-starters', (req, res) => {
    console.log('>>> GET /gemini-starters');
    try {
        console.log("   -> Devolviendo disparadores:", geminiConversationStarters);
        res.json(geminiConversationStarters);
    } catch (error) {
        console.error("[ERROR en GET /gemini-starters]:", error);
        res.status(500).json({ success: false, message: "Error interno del servidor" });
    }
});

app.post('/add-gemini-starter', (req, res) => {
    console.log('>>> POST /add-gemini-starter recibido:', req.body);
    
    try {
        const { trigger, prompt } = req.body;
        
        // Validar que los campos requeridos estén presentes
        if (!trigger || !prompt) {
            console.log('Error: Faltan campos requeridos');
            return res.status(400).json({ 
                success: false, 
                message: 'Se requieren tanto el trigger como el prompt' 
            });
        }

        // Validar que los campos no estén vacíos después de trim
        if (!trigger.trim() || !prompt.trim()) {
            console.log('Error: Campos vacíos después de trim');
            return res.status(400).json({ 
                success: false, 
                message: 'El trigger y el prompt no pueden estar vacíos' 
            });
        }

        // Verificar si ya existe un trigger con este nombre
        const existingTrigger = geminiConversationStarters.find(
            s => s.trigger.toLowerCase() === trigger.trim().toLowerCase()
        );
        
        if (existingTrigger) {
            console.log('Error: Trigger ya existe');
            return res.status(400).json({ 
                success: false, 
                message: 'Ya existe un disparador con este trigger' 
            });
        }
        
        const newStarter = { 
            trigger: trigger.trim(), 
            prompt: prompt.trim() 
        };
        
        geminiConversationStarters.push(newStarter);
        saveData(GEMINI_STARTERS_FILE, geminiConversationStarters);
        
        console.log('Disparador Gemini añadido con éxito:', newStarter);
        res.json({ 
            success: true, 
            starter: newStarter,
            message: 'Disparador añadido con éxito' 
        });
        
    } catch (error) {
        console.error('Error en /add-gemini-starter:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Error interno del servidor al añadir el disparador' 
        });
    }
});

app.delete('/delete-gemini-starter/:trigger', (req, res) => {
    const triggerToDelete = decodeURIComponent(req.params.trigger);
    console.log(`>>> DELETE /delete-gemini-starter/${triggerToDelete}`);
    
    const initialLength = geminiConversationStarters.length;
    geminiConversationStarters = geminiConversationStarters.filter(
        s => s.trigger.toLowerCase() !== triggerToDelete.toLowerCase()
    );
    
    if (geminiConversationStarters.length < initialLength) {
        saveData(GEMINI_STARTERS_FILE, geminiConversationStarters);
        res.json({ success: true, message: 'Disparador eliminado.' });
    } else {
        res.status(404).json({ success: false, message: 'Disparador no encontrado.' });
    }
});

// --- Endpoints para Conversaciones Activas ---
console.log("*** Registrando endpoints para /active-conversations... ***");
app.get('/active-conversations', (req, res) => {
    console.log('>>> GET /active-conversations --- DENTRO DE LA FUNCIÓN');
    try {
        console.log("   -> Devolviendo:", activeAiConversations);
        res.json(activeAiConversations);
    } catch (error) {
        console.error("[ERROR en GET /active-conversations]:", error);
        res.status(500).json({ success: false, message: "Error interno del servidor" });
    }
});

app.post('/stop-ai-conversation/:senderId', (req, res) => {
    const senderId = decodeURIComponent(req.params.senderId);
    console.log(`>>> POST /stop-ai-conversation/${senderId}`);
    if (activeAiConversations[senderId]) {
        delete activeAiConversations[senderId];
        res.json({ success: true, message: `Conversación IA detenida.` });
    } else {
        res.status(404).json({ success: false, message: `Conversación no activa.` });
    }
});

// === INICIALIZACIÓN DEL SERVIDOR ===
try {
    console.log("==== INICIALIZANDO SERVIDOR Y CLIENTE WHATSAPP ====");
    
    // Iniciar servidor con manejo de errores explícito
    const server = app.listen(port, () => {
        console.log(`¡Servidor escuchando en http://localhost:${port}!`);
        console.log('Iniciando cliente de WhatsApp...');
        
        // Inicializar cliente WhatsApp dentro de este callback
        try {
            console.log(">>> LLAMANDO A client.initialize()...");
            client.initialize();
            console.log(">>> LLAMADA A client.initialize() COMPLETADA");
        } catch (err) {
            console.error("ERROR AL INICIALIZAR CLIENTE WHATSAPP:", err);
        }
    });
    
    // Manejar errores del servidor
    server.on('error', (error) => {
        if (error.code === 'EADDRINUSE') {
            console.error(`ERROR: El puerto ${port} ya está en uso. Probablemente otro servidor ya está corriendo.`);
        } else {
            console.error('ERROR INICIANDO SERVIDOR:', error);
        }
    });
    
} catch (err) {2
    console.error("ERROR CRÍTICO AL INICIAR SERVIDOR:", err);
}
