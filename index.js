const makeWASocket = require('@whiskeysockets/baileys').default;
const { 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    makeCacheableSignalKeyStore,
    downloadMediaMessage,
    getContentType
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const fs = require('fs-extra');
const path = require('path');
const Pino = require('pino');

// Import config and utilities
const config = require('./config');
const logger = require('./utils/logger');
const messageHandler = require('./handlers/messageHandler');
const statusHandler = require('./handlers/statusHandler');
const WebDashboard = require('./server');

// Check if running on Render
const isRender = process.env.RENDER === 'true' || process.env.RENDER_EXTERNAL_HOSTNAME;

// Ensure directories exist
fs.ensureDirSync(config.sessionPath);
fs.ensureDirSync(config.mediaPath);
fs.ensureDirSync(config.statusDataPath || './status-data');

class WhatsAppBot {
    constructor() {
        this.sock = null;
        this.isReady = false;
        this.authState = null;
        this.webDashboard = null;
        this.startBot();
    }

    async startBot() {
        try {
            logger.info('🚀 Starting WhatsApp Bot...');
            
            // Log Render info
            if (isRender) {
                console.log('\n══════════════════════════════════════════════════');
                console.log('🚀 RUNNING ON RENDER.COM');
                console.log('══════════════════════════════════════════════════');
                console.log(`🌐 Dashboard URL: ${process.env.RENDER_EXTERNAL_URL}`);
                console.log(`📱 QR Code: Will appear ONLY in web dashboard`);
                console.log('⚠️  Do NOT wait for QR in terminal');
                console.log('══════════════════════════════════════════════════\n');
            }
            
            // Initialize web dashboard
            this.webDashboard = new WebDashboard();
            
            // Create auth state
            const { state, saveCreds } = await useMultiFileAuthState(config.sessionPath);
            this.authState = state;
            
            // Fetch latest version
            const { version, isLatest } = await fetchLatestBaileysVersion();
            logger.info(`📱 Using WA version: ${version.join('.')}`);
            
            // Create socket connection with NO terminal QR
            this.sock = makeWASocket({
                version,
                logger: Pino({ level: 'silent' }),
                printQRInTerminal: false, // CRITICAL: Disable terminal QR
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, Pino({ level: 'error' }))
                },
                browser: ['Ubuntu', 'Chrome', '120.0.0.0'],
                generateHighQualityLinkPreview: true,
                markOnlineOnConnect: true,
                syncFullHistory: false,
                defaultQueryTimeoutMs: 60000,
                emitOwnEvents: true,
                retryRequestDelayMs: 1000,
                fireInitQueries: true,
                shouldIgnoreJid: (jid) => false,
                connectTimeoutMs: 60000,
                keepAliveIntervalMs: 30000,
            });
            
            // Setup event handlers
            this.setupEventHandlers(saveCreds);
            
        } catch (error) {
            logger.error(`❌ Failed to start bot: ${error.message}`);
            console.error('\n❌ Critical error starting bot.');
            
            if (isRender) {
                console.log('🔧 Render troubleshooting:');
                console.log('1. Check environment variables are set');
                console.log('2. Verify all files are uploaded to GitHub');
                console.log('3. Check Render logs for specific errors');
            }
            
            process.exit(1);
        }
    }

    setupEventHandlers(saveCreds) {
        // Handle connection updates
        this.sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                logger.info('QR Code received - sending to web dashboard');
                
                // Send QR to web dashboard ONLY
                if (this.webDashboard) {
                    this.webDashboard.setQrCode(qr);
                    this.webDashboard.setBotStatus('qr_pending');
                }
                
                // Console log for Render (NO QR display)
                console.log('\n══════════════════════════════════════════════════');
                console.log('📱 QR CODE IS READY!');
                console.log('══════════════════════════════════════════════════');
                console.log(`🌐 Open your dashboard: ${process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000'}`);
                console.log('📲 Scan the QR code in the web dashboard');
                console.log('⚠️  QR code will NOT appear in this terminal');
                console.log('══════════════════════════════════════════════════\n');
            }
            
            if (connection === 'open') {
                this.isReady = true;
                logger.success('✅ WhatsApp Client is ready!');
                
                // Update web dashboard
                if (this.webDashboard) {
                    this.webDashboard.setBotStatus('connected');
                }
                
                this.showWelcomeMessage();
                
                // Initialize status monitoring
                if (config.features.statusMonitoring) {
                    setTimeout(() => {
                        statusHandler.initializeStatusMonitor(this.sock);
                    }, 5000);
                }
            }
            
            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
                logger.warn(`🔌 Connection closed, reconnecting: ${shouldReconnect}`);
                
                if (this.webDashboard) {
                    this.webDashboard.setBotStatus('disconnected');
                }
                
                if (shouldReconnect) {
                    console.log('\n🔄 Reconnecting in 5 seconds...\n');
                    setTimeout(() => {
                        this.startBot();
                    }, 5000);
                }
            }
        });
        
        // Save credentials whenever they update
        this.sock.ev.on('creds.update', saveCreds);
        
        // Handle incoming messages
        this.sock.ev.on('messages.upsert', async (m) => {
            const message = m.messages[0];
            if (!message.message || message.key.fromMe) return;
            
            try {
                await messageHandler.handleMessage(this.sock, message);
            } catch (error) {
                logger.error(`💥 Error handling message: ${error.message}`);
            }
        });
        
        // Handle group updates
        this.sock.ev.on('group-participants.update', async (update) => {
            logger.info(`👥 Group update: ${update.id}`);
            
            // Auto welcome message
            if (update.action === 'add' && config.features.groupManagement) {
                try {
                    const welcomeMessage = `👋 Welcome to the group!`;
                    await this.sock.sendMessage(update.id, { 
                        text: welcomeMessage,
                        mentions: update.participants
                    });
                } catch (error) {
                    logger.error(`Failed to send welcome: ${error.message}`);
                }
            }
        });
    }

    async showWelcomeMessage() {
        try {
            console.log('\n══════════════════════════════════════════════════');
            console.log('🤖 WHATSAPP BOT IS NOW CONNECTED!');
            console.log('══════════════════════════════════════════════════');
            
            if (isRender) {
                console.log(`🌐 Dashboard: ${process.env.RENDER_EXTERNAL_URL}`);
                console.log(`🔧 Instance: ${process.env.RENDER_INSTANCE_ID || 'Local'}`);
                console.log(`📊 Memory: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB`);
            }
            
            console.log(`📛 Bot Name: ${config.botName}`);
            console.log(`⚡ Prefix: ${config.prefix}`);
            console.log(`🖥️  Node.js: ${process.version}`);
            console.log(`⏰ Uptime: ${process.uptime().toFixed(2)}s`);
            console.log('══════════════════════════════════════════════════\n');
            console.log('📝 Type "' + config.prefix + 'help" in WhatsApp for commands\n');
            
        } catch (error) {
            logger.error(`Error showing welcome: ${error.message}`);
        }
    }

    // Graceful shutdown
    async shutdown() {
        logger.info('🛑 Shutting down bot gracefully...');
        if (this.sock) {
            await this.sock.end();
        }
        if (this.webDashboard) {
            // Web dashboard will shut down with process
        }
        logger.info('✅ Bot shutdown complete');
    }
}

// Create and start bot
const bot = new WhatsAppBot();

// Handle process signals
process.on('SIGINT', async () => {
    console.log('\n\n🛑 Received shutdown signal');
    await bot.shutdown();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n\n🛑 Received termination signal');
    await bot.shutdown();
    process.exit(0);
});

// Handle errors
process.on('uncaughtException', (error) => {
    logger.error(`💥 Uncaught Exception: ${error.message}`);
    console.error('\n⚠️  Uncaught exception, bot may restart');
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error(`💥 Unhandled Rejection at: ${promise}, reason: ${reason}`);
});

// Export bot
module.exports = bot;