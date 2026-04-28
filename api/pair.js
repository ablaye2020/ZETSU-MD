import { default as makeWASocket, useMultiFileAuthState, Browsers } from '@whiskeysockets/baileys';

export default async function handler(req, res) {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });
    
    const { numero } = req.body;
    
    if (!numero || !numero.match(/^[0-9]{10,15}$/)) {
        return res.status(400).json({ error: "Numéro invalide. Ex: 221783352603" });
    }
    
    const sessionDir = `/tmp/zetsu_pair_${numero}_${Date.now()}`;
    
    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        
        const sock = makeWASocket({
            auth: state,
            browser: Browsers.macOS("Chrome"),
            printQRInTerminal: false,
            patchMessageBeforeSending: (message) => message,
            syncFullHistory: false,
            connectTimeoutMs: 20000,
            defaultQueryTimeoutMs: 15000
        });
        
        let pairingRequested = false;
        let resolved = false;
        
        const result = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                if (!resolved) reject(new Error("Délai dépassé (25s)"));
            }, 25000);
            
            sock.ev.on('connection.update', async (update) => {
                if (resolved) return;
                
                const { connection, lastDisconnect } = update;
                
                if (lastDisconnect?.error?.output?.statusCode === 405) {
                    resolved = true;
                    clearTimeout(timeout);
                    reject(new Error("Numéro banni ou bloqué par WhatsApp"));
                    return;
                }
                
                // ✅ LE BON MOMENT : connection === 'connecting'
                if (connection === 'connecting' && !pairingRequested) {
                    pairingRequested = true;
                    
                    // Petit délai pour laisser WhatsApp s'initialiser
                    await new Promise(r => setTimeout(r, 1500));
                    
                    try {
                        const code = await sock.requestPairingCode(numero);
                        const formattedCode = code?.match(/.{1,4}/g)?.join("-") || code;
                        resolved = true;
                        clearTimeout(timeout);
                        resolve({ code: formattedCode });
                    } catch (err) {
                        resolved = true;
                        clearTimeout(timeout);
                        reject(err);
                    }
                }
            });
            
            sock.ev.on('creds.update', saveCreds);
        });
        
        // Fermeture propre de la connexion
        setTimeout(() => {
            try { sock?.end(); } catch(e) {}
        }, 1000);
        
        return res.status(200).json({
            success: true,
            code: result.code,
            message: "Saisis ce code dans WhatsApp > Paramètres > Appareils liés"
        });
        
    } catch (err) {
        console.error("Pairing error:", err);
        return res.status(500).json({
            error: err.message || "Erreur lors du pairing",
            details: "Vérifie ton numéro (sans +, sans espace, ex: 221783352603)"
        });
    }
}
