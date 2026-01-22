const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

// Vercel Serverless Function
module.exports = async (req, res) => {
    console.log("Function Started: Initializing QR Scanner...");

    try {
        // --------------------------------------------------------------------------------
        // 1. DYNAMIC IMPORT (CRITICAL FIX)
        // This allows us to use the latest ESM Baileys in a CommonJS Vercel environment
        // --------------------------------------------------------------------------------
        const { 
            default: makeWASocket, 
            useMultiFileAuthState, 
            delay, 
            fetchLatestBaileysVersion,
            makeCacheableSignalKeyStore,
            Browsers
        } = await import('@whiskeysockets/baileys');
        
        const pino = (await import('pino')).default;
        // --------------------------------------------------------------------------------

        // 2. Setup Session Directory (Must use /tmp on Vercel)
        const sessionDir = path.join('/tmp', 'baileys_auth_temp');
        
        // Clean up previous sessions to force a NEW QR code every time
        if (fs.existsSync(sessionDir)) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }
        fs.mkdirSync(sessionDir, { recursive: true });

        // 3. Initialize Auth & Socket
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
            // Use Chrome to look like a real browser
            browser: Browsers.macOS('Desktop'), 
            connectTimeoutMs: 10000,
        });

        // 4. Handle the Connection
        await new Promise((resolve, reject) => {
            
            // TIMEOUT SAFETY: 
            // Vercel Free Tier kills processes after ~10 seconds. 
            // We set a hard stop to prevent "Invocation Failed" errors.
            const timeout = setTimeout(() => {
                try { sock.end(undefined); } catch(e) {}
                if (!res.headersSent) {
                    res.status(504).send('<h1>Timeout</h1><p>The scan took too long. Please refresh the page to try again.</p>');
                }
                resolve();
            }, 9500); // 9.5 seconds

            sock.ev.on('creds.update', saveCreds);

            sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr } = update;

                // --- SCENARIO A: QR Code Generated ---
                if (qr) {
                    console.log("QR Generated");
                    const url = await QRCode.toDataURL(qr);
                    
                    if (!res.headersSent) {
                        res.setHeader('Content-Type', 'text/html');
                        // We write the HTML immediately but keep the connection open
                        res.write(`
                            <html>
                            <head>
                                <meta http-equiv="refresh" content="10">
                                <style>
                                    body { font-family: sans-serif; text-align: center; padding: 20px; }
                                    img { border: 5px solid #25D366; border-radius: 10px; margin: 20px 0; }
                                    .instruction { background: #f0f0f0; padding: 10px; border-radius: 5px; display: inline-block;}
                                </style>
                            </head>
                            <body>
                                <h1>Scan this QR Code Fast!</h1>
                                <img src="${url}" width="300" height="300"/>
                                <br>
                                <div class="instruction">
                                    <p>1. Open WhatsApp > Linked Devices</p>
                                    <p>2. Scan this code within 8 seconds</p>
                                </div>
                                <p><b>If successful, I will send the file to your WhatsApp.</b></p>
                            </body>
                            </html>
                        `);
                    }
                }

                // --- SCENARIO B: Connected Successfully ---
                if (connection === 'open') {
                    clearTimeout(timeout);
                    console.log('✅ Connected to WhatsApp!');
                    
                    await delay(1000); // Wait for files to write to disk

                    const credsPath = path.join(sessionDir, 'creds.json');
                    
                    if (fs.existsSync(credsPath)) {
                        const fileBuffer = fs.readFileSync(credsPath);

                        // Send the session file to YOURSELF
                        await sock.sendMessage(sock.user.id, {
                            document: fileBuffer,
                            mimetype: 'application/json',
                            fileName: 'creds.json',
                            caption: '🤖 **SESSION FILE GENERATED**\n\nDownload this file and upload it to your bot deployment.'
                        });

                        if (!res.headersSent) {
                            res.write('<script>alert("SUCCESS! The creds.json file has been sent to your WhatsApp Saved Messages.");</script>');
                        }
                    }

                    // Graceful exit
                    await delay(1000);
                    try { sock.end(undefined); } catch(e) {}
                    if (!res.headersSent) res.end();
                    resolve();
                }

                // --- SCENARIO C: Error/Close ---
                if (connection === 'close') {
                    if (!res.headersSent) {
                        // If connection closed before QR scan
                        // We just resolve to finish the HTTP request
                    }
                }
            });
        });

    } catch (error) {
        console.error("Critical Error:", error);
        if (!res.headersSent) {
            res.status(500).send(`<h1>Error</h1><pre>${error.message}</pre>`);
        }
    }
};
