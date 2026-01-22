const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

module.exports = async (req, res) => {
    console.log("QR Function Started...");

    try {
        // --- DYNAMIC IMPORT FOR BAILEYS (Standard for v6.7+) ---
        const { 
            default: makeWASocket, 
            useMultiFileAuthState, 
            delay, 
            fetchLatestBaileysVersion,
            makeCacheableSignalKeyStore,
            Browsers,     // <--- Use this helper from the library
            DisconnectReason
        } = await import('@whiskeysockets/baileys');
        
        const pino = (await import('pino')).default;
        // --------------------------------------------------------

        const sessionDir = path.join('/tmp', 'baileys_auth_temp');
        
        // Clean start
        if (fs.existsSync(sessionDir)) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }
        fs.mkdirSync(sessionDir, { recursive: true });

        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const { version, isLatest } = await fetchLatestBaileysVersion();
        
        console.log(`Using WA v${version.join('.')} (Latest: ${isLatest})`);

        const sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            auth: {
                creds: state.creds,
                // v6.7+ Requirement: Cacheable Signal Key Store
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" })),
            },
            // CORRECT BROWSER IDENTITY
            // Using "Ubuntu" is often more trusted than "Baileys"
            browser: Browsers.ubuntu('Chrome'), 
            
            // SERVERLESS OPTIMIZATIONS
            syncFullHistory: false, // Critical: Stops Vercel timeout during sync
            generateHighQualityLinkPreview: false,
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 10000, // Keep WebSocket alive
            retryRequestDelayMs: 500,
        });

        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                try { sock.end(undefined); } catch(e) {}
                resolve();
            }, 50000);

            sock.ev.on('creds.update', saveCreds);

            sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr } = update;

                if (qr) {
                    const url = await QRCode.toDataURL(qr);
                    if (!res.headersSent) {
                        res.setHeader('Content-Type', 'text/html');
                        res.write(`
                            <html>
                            <head>
                                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                                <meta http-equiv="refresh" content="20">
                                <style>
                                    body { font-family: sans-serif; text-align: center; padding: 20px; }
                                    img { border: 5px solid #25D366; border-radius: 10px; }
                                </style>
                            </head>
                            <body>
                                <h2>Scan Fast</h2>
                                <img src="${url}" width="250"/>
                                <p>If "Can't Link" appears, use Option 2 (Pairing Code).</p>
                            </body>
                            </html>
                        `);
                    }
                }

                if (connection === 'open') {
                    clearTimeout(timeout);
                    await delay(1000);
                    
                    const credsPath = path.join(sessionDir, 'creds.json');
                    if (fs.existsSync(credsPath)) {
                        const fileBuffer = fs.readFileSync(credsPath);
                        await sock.sendMessage(sock.user.id, {
                            document: fileBuffer,
                            mimetype: 'application/json',
                            fileName: 'creds.json',
                            caption: '✅ **Connected!**'
                        });
                        if (!res.headersSent) res.write("<script>alert('Success! Check WhatsApp.');</script>");
                    }
                    await delay(1000);
                    sock.end(undefined);
                    resolve();
                }

                if (connection === 'close') {
                    const code = (lastDisconnect?.error)?.output?.statusCode;
                    // If 403 or 405, it means IP Blocked
                    if (code === DisconnectReason.connectionClosed || code === DisconnectReason.connectionLost) {
                        console.log("Connection lost, Vercel might be killing the socket.");
                    }
                }
            });
        });

    } catch (error) {
        console.error(error);
        if (!res.headersSent) res.status(500).send(error.message);
    }
};
