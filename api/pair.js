import { default as makeWASocket, useMultiFileAuthState, Browsers } from '@whiskeysockets/baileys';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });
    
    const { numero } = req.body;
    if (!numero || !numero.match(/^[0-9]{10,15}$/)) {
        return res.status(400).json({ error: "Numéro invalide. Ex: 221783352603" });
    }
    
    const sessionId = `pair_${numero}_${Date.now()}`;
    const sessionDir = `/tmp/sessions/${sessionId}`;
    
    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        
        const sock = makeWASocket({
            auth: state,
            browser: Browsers.macOS("Chrome"),
            printQRInTerminal: false,
            patchMessageBeforeSending: (message) => message,
            syncFullHistory: false
        });
        
        let pairingRequested = false;
        
        const codePromise = new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => reject(new Error("Délai dépassé (25s)")), 25000);
            
            sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect } = update;
                
                if (lastDisconnect?.error?.output?.statusCode === 405) {
                    clearTimeout(timeoutId);
                    reject(new Error("Numéro banni ou bloqué"));
                    return;
                }
                
                if (connection === 'connecting' && !pairingRequested && !sock.authState.creds.registered) {
                    pairingRequested = true;
                    await new Promise(r => setTimeout(r, 1500));
                    const code = await sock.requestPairingCode(numero);
                    const formattedCode = code?.match(/.{1,4}/g)?.join("-");
                    clearTimeout(timeoutId);
                    resolve({ code: formattedCode });
                }
            });
            
            sock.ev.on('creds.update', saveCreds);
        });
        
        const result = await codePromise;
        
        if (result.code) {
            return res.status(200).json({ success: true, code: result.code });
        }
        
    } catch (err) {
        console.error("❌ Erreur:", err);
        return res.status(500).json({ error: err.message || "Erreur lors du pairing" });
    }
}
