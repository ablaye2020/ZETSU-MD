import { default as makeWASocket, useMultiFileAuthState, Browsers } from '@whiskeysockets/baileys';

export default async function handler(req, res) {
    // Autoriser CORS pour les requêtes depuis le navigateur
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Méthode non autorisée' });
    }
    
    const { numero } = req.body;
    
    // Vérification du numéro
    if (!numero || !numero.match(/^[0-9]{10,15}$/)) {
        return res.status(400).json({ 
            error: "Numéro invalide. Exemple: 221783352603 (sans +, sans espace)" 
        });
    }
    
    // Création d'un ID de session unique pour chaque requête
    const sessionId = `pair_${numero}_${Date.now()}`;
    const sessionDir = `/tmp/sessions/${sessionId}`;
    
    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        
        const sock = makeWASocket({
            auth: state,
            browser: Browsers.macOS("Chrome"),
            printQRInTerminal: false,
            patchMessageBeforeSending: (message) => message,
            syncFullHistory: false,
            // Éviter les erreurs de timeout
            connectTimeoutMs: 20000,
            defaultQueryTimeoutMs: 15000
        });
        
        let pairingRequested = false;
        let responseSent = false;
        
        // Promesse pour attendre le code
        const codePromise = new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                reject(new Error("Délai dépassé (25s)"));
            }, 25000);
            
            sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect } = update;
                
                // Vérifier si le numéro est banni
                if (lastDisconnect?.error?.output?.statusCode === 405) {
                    clearTimeout(timeoutId);
                    reject(new Error("Numéro banni ou bloqué par WhatsApp"));
                    return;
                }
                
                // ✅ LE BON MOMENT : connection === 'connecting'
                if (connection === 'connecting' && !pairingRequested && !sock.authState.creds.registered) {
                    pairingRequested = true;
                    
                    // Petit délai pour laisser WhatsApp s'initialiser
                    await new Promise(r => setTimeout(r, 1500));
                    
                    try {
                        const code = await sock.requestPairingCode(numero);
                        const formattedCode = code?.match(/.{1,4}/g)?.join("-");
                        clearTimeout(timeoutId);
                        resolve({ code: formattedCode });
                    } catch (pairErr) {
                        clearTimeout(timeoutId);
                        reject(pairErr);
                    }
                }
                
                // Si déjà connecté
                if (connection === 'open' && sock.authState.creds.registered) {
                    clearTimeout(timeoutId);
                    resolve({ alreadyConnected: true });
                }
            });
            
            sock.ev.on('creds.update', saveCreds);
        });
        
        const result = await codePromise;
        
        if (!responseSent) {
            responseSent = true;
            if (result.code) {
                return res.status(200).json({
                    success: true,
                    code: result.code,
                    message: "Saisis ce code dans WhatsApp > Paramètres > Appareils liés"
                });
            } else if (result.alreadyConnected) {
                return res.status(200).json({ success: true, message: "Déjà connecté !" });
            }
        }
        
    } catch (err) {
        console.error("❌ Erreur pairing:", err);
        if (!res.headersSent) {
            return res.status(500).json({ 
                error: err.message || "Erreur lors du pairing",
                details: "Vérifie ton numéro et réessaie"
            });
        }
    }
}
