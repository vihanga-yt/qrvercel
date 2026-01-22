const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

module.exports = async (req, res) => {
    console.log("Function Started...");

    try {
        // --- DYNAMIC IMPORT ---
        const { 
            default: makeWASocket, 
            useMultiFileAuthState, 
            delay, 
            fetchLatestBaileysVersion,
            makeCacheableSignalKeyStore,
            Browsers
        } = await import('@whiskeysockets/baileys');
        
        const pino = (await import('pino')).default;
        // ----------------------

        const sessionDir = path.join('/tmp', 'baileys_auth_temp');
        
        // Always clean start
        if (fs.existsSync(sessionDir)) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }
        fs.mkdirSync(sessionDir, { recursive: true });

        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" })),
            },
            // FIX 1: Masquerade as a real Ubuntu Desktop Chrome to prevent "Can't Link"
            browser: ["Ubuntu", "Chrome", "20.0.04"], 
            
            // FIX 2: Connection Stability for Serverless
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 10000,
            emitOwnEvents: true,
            retryRequestDelayMs: 250,
            
            // FIX 3: Speed - Do not sync history or it will timeout on Vercel
            syncFullHistory: false, 
            generateHighQualityLinkPreview: false,
        });

        await new Promise((resolve, reject) => {
            
            const serverTimeout = setTimeout(() => {
                try { sock.end(undefined); } catch(e) {}
                resolve();
            }, 55000); // 55s limit

            sock.ev.on('creds.update', saveCreds);

            sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr } = update;

                // --- QR GENERATION ---
                if (qr) {
                    const url = await QRCode.toDataURL(qr);
                    
                    if (!res.headersSent) {
                        res.setHeader('Content-Type', 'text/html');
                        res.write(`
                            <html>
                            <head>
                                <title>Scan Now</title>
                                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                                <style>
                                    body { font-family: sans-serif; text-align: center; background: #fff; padding-top: 20px; }
                                    h2 { margin-bottom: 5px; }
                                    img { border: 5px solid #25D366; border-radius: 8px; }
                                    .timer { font-size: 20px; color: #d9534f; font-weight: bold; margin: 15px 0; }
                                    .tip { background: #eee; padding: 10px; border-radius: 5px; font-size: 13px; display: inline-block; max-width: 300px;}
                                </style>
                            </head>
                            <body>
                                <h2>Scan Fast!</h2>
                                <img src="${url}" width="280" height="280"/>
                                
                                <div class="timer">Expires in <span id="time">20</span>s</div>
                                
                                <div class="tip">
                                    <b>Fix "Can't Link":</b><br>
                                    1. Keep your phone screen on.<br>
                                    2. Don't let this browser tab go to background.<br>
                                    3. Scan immediately.
                                </div>

                                <script>
                                    let t = 20;
                                    setInterval(() => {
                                        t--;
                                        document.getElementById('time').innerText = t;
                                        if(t <= 0) document.body.innerHTML = "<h3>Expired. Refresh page.</h3>";
                                    }, 1000);
                                </script>
                            </body>
                            </html>
                        `);
                    }
                }

                // --- SUCCESS ---
                if (connection === 'open') {
                    clearTimeout(serverTimeout);
                    await delay(1000); 

                    const credsPath = path.join(sessionDir, 'creds.json');
                    
                    if (fs.existsSync(credsPath)) {
                        const fileBuffer = fs.readFileSync(credsPath);

                        await sock.sendMessage(sock.user.id, {
                            document: fileBuffer,
                            mimetype: 'application/json',
                            fileName: 'creds.json',
                            caption: '✅ **Session Linked!**\n\nHere is your file.'
                        });

                        if (!res.headersSent) {
                            res.write(`<script>alert("SUCCESS! File sent to your WhatsApp."); window.close();</script>`);
                        }
                    }
                    
                    await delay(1000);
                    try { sock.end(undefined); } catch(e) {}
                    if (!res.headersSent) res.end();
                    resolve();
                }
            });
        });

    } catch (error) {
        console.error(error);
        if (!res.headersSent) res.status(500).send(error.message);
    }
};
