const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    delay, 
    DisconnectReason 
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs-extra');
const path = require('path');

module.exports = async (req, res) => {
    // 1. Setup paths
    // We use /tmp because it is the only writable folder on Vercel
    const sessionDir = path.join('/tmp', 'auth_temp_session');
    
    // Clean up previous session to ensure a fresh QR code
    if (fs.existsSync(sessionDir)) {
        fs.removeSync(sessionDir);
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    try {
        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: ['Vercel QR Gen', 'Chrome', '1.0.0']
        });

        // Use a promise to keep the function alive
        await new Promise((resolve, reject) => {
            
            // Timeout safety (Vercel Free Tier limits to 10s-60s)
            const timeout = setTimeout(() => {
                sock.end(undefined);
                res.status(504).send("<h1>Timeout</h1><p>You didn't scan in time. Refresh to try again.</p>");
                resolve();
            }, 40000); // 40 seconds max

            sock.ev.on('creds.update', saveCreds);

            sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr } = update;

                // 2. Display QR Code in Browser
                if (qr) {
                    // Convert QR string to Image Data URL
                    const url = await QRCode.toDataURL(qr);
                    
                    // We send HTML immediately but keep the connection logic running
                    // Note: In strict Serverless, sending response might kill process. 
                    // But Vercel usually waits for the Event Loop to clear.
                    if (!res.headersSent) {
                        res.write(`
                            <html>
                            <head>
                                <meta http-equiv="refresh" content="20"> <!-- Auto refresh if stuck -->
                                <style>
                                    body { font-family: sans-serif; text-align: center; padding: 50px; }
                                    img { border: 5px solid #000; border-radius: 10px; }
                                </style>
                            </head>
                            <body>
                                <h2>Scan this QR Code</h2>
                                <p>Open WhatsApp > Linked Devices > Link a Device</p>
                                <img src="${url}" />
                                <p><b>Wait...</b> after scanning, I will send the session file to your WhatsApp.</p>
                            </body>
                            </html>
                        `);
                    }
                }

                // 3. Handle Successful Connection
                if (connection === 'open') {
                    clearTimeout(timeout);
                    console.log('✅ Connected! Sending session file...');

                    await delay(1000); // Wait for files to settle

                    // Read the creds.json file from /tmp
                    const credsPath = path.join(sessionDir, 'creds.json');
                    
                    if (fs.existsSync(credsPath)) {
                        const fileBuffer = fs.readFileSync(credsPath);

                        // 4. Send the file to the user's own number (Saved Messages)
                        await sock.sendMessage(sock.user.id, { 
                            document: fileBuffer, 
                            mimetype: 'application/json', 
                            fileName: 'creds.json',
                            caption: 'Here is your session file! 🤖\n\n1. Download this.\n2. Rename/Place it in your auth folder.\n3. Deploy your bot.'
                        });

                        if (!res.headersSent) {
                            res.write('<script>alert("Success! Check your WhatsApp Saved Messages.");</script>');
                        }
                    }

                    // Close connection gracefully
                    await delay(2000);
                    await sock.end(undefined);
                    
                    if (!res.headersSent) res.end();
                    resolve();
                }

                // Handle Close
                if (connection === 'close') {
                    const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
                    if (!shouldReconnect) {
                         if (!res.headersSent) res.end("<h1>Logged Out / Error</h1>");
                         resolve();
                    }
                }
            });
        });

    } catch (err) {
        console.error(err);
        if (!res.headersSent) res.status(500).send(err.message);
    }
};
