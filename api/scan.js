const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

module.exports = async (req, res) => {
    console.log("Function Started...");

    try {
        // --- DYNAMIC IMPORT FOR BAILEYS (Fixes ESM Error) ---
        const { 
            default: makeWASocket, 
            useMultiFileAuthState, 
            delay, 
            fetchLatestBaileysVersion,
            makeCacheableSignalKeyStore,
            Browsers
        } = await import('@whiskeysockets/baileys');
        
        const pino = (await import('pino')).default;
        // ----------------------------------------------------

        // 1. Setup Session Directory in /tmp
        const sessionDir = path.join('/tmp', 'baileys_auth_temp');
        
        // Clean start: Remove old session
        if (fs.existsSync(sessionDir)) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }
        fs.mkdirSync(sessionDir, { recursive: true });

        // 2. Initialize Auth
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
            browser: Browsers.macOS('Desktop'), 
            connectTimeoutMs: 60000, // Long timeout
        });

        // 3. Handle Request
        await new Promise((resolve, reject) => {
            
            // Server-side Timeout (Kill process after 50s to be safe)
            const serverTimeout = setTimeout(() => {
                try { sock.end(undefined); } catch(e) {}
                resolve();
            }, 50000);

            sock.ev.on('creds.update', saveCreds);

            sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr } = update;

                // --- GENERATE QR ---
                if (qr) {
                    const url = await QRCode.toDataURL(qr);
                    
                    if (!res.headersSent) {
                        res.setHeader('Content-Type', 'text/html');
                        // HTML with LIVE COUNTDOWN
                        res.write(`
                            <html>
                            <head>
                                <title>WhatsApp Scan</title>
                                <style>
                                    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; text-align: center; background-color: #f0f2f5; padding-top: 50px; }
                                    .card { background: white; padding: 30px; border-radius: 15px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); display: inline-block; }
                                    h2 { color: #41525d; margin-top: 0; }
                                    img { border: 8px solid white; outline: 2px solid #e9edef; border-radius: 8px; }
                                    .timer-box { font-size: 24px; font-weight: bold; color: #d9534f; margin: 20px 0; }
                                    p { color: #8696a0; font-size: 14px; }
                                    .status { margin-top: 15px; padding: 10px; border-radius: 5px; background: #e9edef; display: none;}
                                </style>
                            </head>
                            <body>
                                <div class="card">
                                    <h2>Link with WhatsApp</h2>
                                    <img src="${url}" width="264" height="264"/>
                                    
                                    <div class="timer-box">
                                        Time remaining: <span id="countdown">20</span>s
                                    </div>

                                    <div id="instruction">
                                        <p>1. Open WhatsApp on your phone</p>
                                        <p>2. Tap Menu > Linked Devices > Link a Device</p>
                                        <p>3. Point your phone at this screen</p>
                                    </div>
                                    
                                    <div id="status" class="status"></div>
                                </div>

                                <script>
                                    let timeLeft = 20; // Exact time a WA QR is valid
                                    const countdownEl = document.getElementById('countdown');
                                    const statusEl = document.getElementById('status');
                                    
                                    const timer = setInterval(() => {
                                        timeLeft--;
                                        countdownEl.innerText = timeLeft;
                                        
                                        if (timeLeft <= 0) {
                                            clearInterval(timer);
                                            countdownEl.style.color = 'gray';
                                            countdownEl.innerText = "Expired";
                                            alert("QR Code Expired. Please refresh the page manually.");
                                        }
                                    }, 1000);
                                </script>
                            </body>
                            </html>
                        `);
                    }
                }

                // --- CONNECTED ---
                if (connection === 'open') {
                    clearTimeout(serverTimeout);
                    
                    await delay(1000); 

                    const credsPath = path.join(sessionDir, 'creds.json');
                    
                    if (fs.existsSync(credsPath)) {
                        const fileBuffer = fs.readFileSync(credsPath);

                        // Send file to Saved Messages
                        await sock.sendMessage(sock.user.id, {
                            document: fileBuffer,
                            mimetype: 'application/json',
                            fileName: 'creds.json',
                            caption: '✅ **Session Connected!**\n\nDownload this file and use it for your bot.'
                        });

                        // Notify Browser
                        if (!res.headersSent) {
                            res.write(`
                                <script>
                                    clearInterval(timer);
                                    document.getElementById('countdown').innerText = "CONNECTED";
                                    document.getElementById('countdown').style.color = 'green';
                                    document.getElementById('instruction').style.display = 'none';
                                    alert("SUCCESS! Check your WhatsApp Saved Messages for the file.");
                                </script>
                            `);
                        }
                    }

                    await delay(2000);
                    try { sock.end(undefined); } catch(e) {}
                    if (!res.headersSent) res.end();
                    resolve();
                }

                // --- CLOSED ---
                if (connection === 'close') {
                   // Silence is golden in serverless
                }
            });
        });

    } catch (error) {
        console.error("Error:", error);
        if (!res.headersSent) res.status(500).send("Server Error: " + error.message);
    }
};
