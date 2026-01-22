const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    delay, 
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

module.exports = async (req, res) => {
    console.log("Function started...");

    try {
        // 1. Setup paths safely
        // Vercel only allows writing to /tmp
        const sessionDir = path.join('/tmp', 'auth_temp_session');
        
        // Clean up previous session safely using standard FS
        if (fs.existsSync(sessionDir)) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }
        fs.mkdirSync(sessionDir, { recursive: true });

        // 2. Initialize Auth
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: ['Vercel QR', 'Chrome', '1.0.0'],
            connectTimeoutMs: 10000,
        });

        // 3. The Promise Wrapper
        await new Promise((resolve, reject) => {
            
            // Timeout to prevent hanging (kill after 20s)
            const timeout = setTimeout(() => {
                if (!res.headersSent) {
                    res.status(504).send("<h1>Timeout</h1><p>QR code expired or took too long.</p>");
                }
                sock.end(undefined);
                resolve();
            }, 20000);

            sock.ev.on('creds.update', saveCreds);

            sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr } = update;

                // A. QR Code Received -> Send HTML
                if (qr) {
                    console.log("QR Generated");
                    const url = await QRCode.toDataURL(qr);
                    
                    if (!res.headersSent) {
                        res.setHeader('Content-Type', 'text/html');
                        res.write(`
                            <html>
                            <head>
                                <meta http-equiv="refresh" content="10">
                                <style>body{text-align:center; font-family:sans-serif; padding:20px;}</style>
                            </head>
                            <body>
                                <h2>Scan Fast!</h2>
                                <img src="${url}" width="250"/>
                                <p>Waiting for connection...</p>
                            </body>
                            </html>
                        `);
                    }
                }

                // B. Connected -> Send File
                if (connection === 'open') {
                    clearTimeout(timeout);
                    console.log('✅ Connected!');

                    await delay(1000); 

                    const credsPath = path.join(sessionDir, 'creds.json');
                    
                    if (fs.existsSync(credsPath)) {
                        const fileBuffer = fs.readFileSync(credsPath);

                        // Send to "Saved Messages" (yourself)
                        await sock.sendMessage(sock.user.id, { 
                            document: fileBuffer, 
                            mimetype: 'application/json', 
                            fileName: 'creds.json',
                            caption: 'Here is your new session file!'
                        });

                        // Tell the browser
                        if (!res.headersSent) {
                            res.write('<script>alert("Success! Check your WhatsApp.");</script>');
                        }
                    } else {
                        console.error("creds.json missing!");
                    }

                    await delay(2000);
                    await sock.end(undefined);
                    if (!res.headersSent) res.end();
                    resolve();
                }

                // C. Errors / Disconnects
                if (connection === 'close') {
                    const reason = (lastDisconnect?.error)?.output?.statusCode;
                    if (reason !== DisconnectReason.loggedOut && reason !== undefined) {
                        // Reconnection is hard in serverless, usually better to restart
                        console.log("Connection closed, reason:", reason);
                    } else {
                        console.log("Logged out / Finished");
                        if (!res.headersSent) res.end();
                        resolve();
                    }
                }
            });
        });

    } catch (err) {
        console.error("CRASH:", err);
        // This ensures you see the error in the browser instead of "500"
        if (!res.headersSent) {
            res.status(500).send(`<h1>Error</h1><pre>${err.message}</pre>`);
        }
    }
};
