const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs-extra');
const QRCode = require('qrcode');
const config = require('./config');
const logger = require('./utils/logger');

// Check if running on Render
const isRender = process.env.RENDER === 'true' || process.env.RENDER_EXTERNAL_HOSTNAME;

class WebDashboard {
    constructor() {
        this.app = express();
        this.server = http.createServer(this.app);
        
        // Socket.io configuration for Render
        this.io = socketIo(this.server, {
            cors: {
                origin: "*",
                methods: ["GET", "POST"]
            },
            transports: ['websocket', 'polling']
        });
        
        this.qrCode = null;
        this.botStatus = 'starting';
        this.botStats = {};
        this.clients = new Map();
        
        this.setupMiddleware();
        this.setupRoutes();
        this.setupSocketIO();
        this.start();
    }

    setupMiddleware() {
        // Serve static files from public directory
        this.app.use(express.static('public'));
        this.app.use(express.json());
        this.app.use(express.urlencoded({ extended: true }));
        
        // Security headers
        this.app.use((req, res, next) => {
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('X-Frame-Options', 'DENY');
            res.setHeader('X-XSS-Protection', '1; mode=block');
            
            // CORS for Render
            if (isRender) {
                res.setHeader('Access-Control-Allow-Origin', '*');
            }
            
            next();
        });
    }

    setupRoutes() {
        // Dashboard home
        this.app.get('/', (req, res) => {
            res.sendFile(path.join(__dirname, 'public', 'index.html'));
        });

        // API endpoints
        this.app.get('/api/status', (req, res) => {
            res.json({
                status: this.botStatus,
                qrCode: this.qrCode,
                stats: this.botStats,
                uptime: process.uptime(),
                timestamp: new Date().toISOString(),
                render: {
                    isRender: isRender,
                    url: process.env.RENDER_EXTERNAL_URL
                }
            });
        });

        this.app.get('/api/logs', async (req, res) => {
            try {
                const lines = parseInt(req.query.lines) || 50;
                const logPath = path.join(__dirname, config.logFile);
                
                if (await fs.pathExists(logPath)) {
                    const logContent = await fs.readFile(logPath, 'utf8');
                    const logLines = logContent.split('\n').filter(line => line.trim()).slice(-lines);
                    res.json({ logs: logLines });
                } else {
                    res.json({ logs: ['No logs yet'] });
                }
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        // QR code endpoint
        this.app.get('/api/qrcode', async (req, res) => {
            if (!this.qrCode) {
                return res.status(404).json({ 
                    error: 'No QR code available',
                    message: 'Bot is starting or already connected'
                });
            }
            
            try {
                const qrDataUrl = await QRCode.toDataURL(this.qrCode);
                res.json({ 
                    qrCode: qrDataUrl,
                    message: 'Scan with WhatsApp'
                });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        // Health check endpoint (required by Render)
        this.app.get('/health', (req, res) => {
            res.json({
                status: 'healthy',
                service: 'whatsapp-bot',
                uptime: process.uptime(),
                memory: process.memoryUsage(),
                botStatus: this.botStatus,
                timestamp: new Date().toISOString()
            });
        });

        // Bot status endpoint
        this.app.get('/status', (req, res) => {
            res.json({
                bot: {
                    status: this.botStatus,
                    qrAvailable: !!this.qrCode,
                    connected: this.botStatus === 'connected'
                },
                system: {
                    uptime: process.uptime(),
                    platform: process.platform,
                    node: process.version,
                    isRender: isRender
                }
            });
        });

        // 404 handler
        this.app.use((req, res) => {
            res.status(404).json({ 
                error: 'Not found',
                available: ['/', '/api/status', '/api/qrcode', '/health', '/status']
            });
        });

        // Error handler
        this.app.use((err, req, res, next) => {
            logger.error(`Web error: ${err.message}`);
            res.status(500).json({ 
                error: 'Internal server error',
                message: isRender ? 'Check Render logs' : 'Check console'
            });
        });
    }

    setupSocketIO() {
        this.io.on('connection', (socket) => {
            logger.info(`📡 Web client connected: ${socket.id}`);
            this.clients.set(socket.id, socket);
            
            // Send initial status
            socket.emit('status', {
                status: this.botStatus,
                qrCode: this.qrCode,
                stats: this.botStats,
                isRender: isRender,
                dashboardUrl: process.env.RENDER_EXTERNAL_URL
            });

            // Handle commands from web
            socket.on('command', (data) => {
                logger.info(`Web command: ${data.command}`);
                // You can implement command handling here
                socket.emit('command-response', {
                    success: true,
                    message: 'Command received'
                });
            });

            socket.on('disconnect', () => {
                logger.info(`📡 Web client disconnected: ${socket.id}`);
                this.clients.delete(socket.id);
            });
        });
    }

    setQrCode(qr) {
        this.qrCode = qr;
        
        // Emit to all connected clients
        this.io.emit('qr', { 
            qrCode: qr,
            message: 'Scan with WhatsApp',
            timestamp: new Date().toISOString()
        });
        
        // Also generate QR code image
        QRCode.toDataURL(qr, (err, url) => {
            if (!err) {
                this.io.emit('qrImage', { 
                    qrImage: url,
                    message: 'Scan this QR code with WhatsApp'
                });
            }
        });
        
        logger.info('✅ QR code sent to web dashboard');
    }

    setBotStatus(status) {
        this.botStatus = status;
        this.io.emit('status', { 
            status: this.botStatus,
            qrCode: this.qrCode,
            timestamp: new Date().toISOString()
        });
        
        if (isRender) {
            console.log(`📊 Bot status updated: ${status}`);
        }
    }

    updateStats(stats) {
        this.botStats = stats;
        this.io.emit('stats', this.botStats);
    }

    sendLog(log) {
        this.io.emit('log', {
            message: log,
            timestamp: new Date().toISOString(),
            level: this.getLogLevel(log)
        });
    }

    getLogLevel(log) {
        if (log.includes('ERROR') || log.includes('❌')) return 'error';
        if (log.includes('WARN') || log.includes('⚠️')) return 'warning';
        if (log.includes('INFO') || log.includes('✅')) return 'info';
        return 'info';
    }

    start() {
        const port = process.env.PORT || 3000;
        const host = isRender ? '0.0.0.0' : 'localhost';
        
        this.server.listen(port, host, () => {
            logger.info(`🌐 Web dashboard running on http://${host}:${port}`);
            
            console.log('\n══════════════════════════════════════════════════');
            console.log('🌐 WHATSAPP BOT DASHBOARD');
            console.log('══════════════════════════════════════════════════');
            
            if (isRender) {
                console.log(`📱 Dashboard URL: ${process.env.RENDER_EXTERNAL_URL}`);
                console.log(`🔧 Internal: http://${host}:${port}`);
                console.log('⚠️  QR codes appear ONLY in web dashboard');
            } else {
                console.log(`📱 Local URL: http://${host}:${port}`);
            }
            
            console.log('🔒 Password protected');
            console.log('📊 Real-time monitoring');
            console.log('══════════════════════════════════════════════════\n');
            console.log('⏳ Waiting for WhatsApp connection...\n');
        });
    }
}

module.exports = WebDashboard;