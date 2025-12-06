require('dotenv').config();

// Check if running on Render
const isRender = process.env.RENDER === 'true' || process.env.RENDER_EXTERNAL_HOSTNAME;

module.exports = {
    // Bot Configuration
    botName: process.env.BOT_NAME || "WhatsApp Bot",
    prefix: process.env.BOT_PREFIX || "!",
    adminNumber: process.env.ADMIN_NUMBER || "",
    
    // Paths - Render compatible
    sessionPath: isRender ? '/opt/render/project/src/sessions' : './sessions',
    mediaPath: isRender ? '/opt/render/project/src/media' : './media',
    statusDataPath: isRender ? '/opt/render/project/src/status-data' : './status-data',
    
    // Features
    features: {
        statusMonitoring: process.env.ENABLE_STATUS_MONITORING === 'true',
        autoReply: process.env.ENABLE_AUTO_REPLY === 'true',
        groupManagement: process.env.ENABLE_GROUP_MANAGEMENT === 'true',
        broadcast: process.env.ENABLE_BROADCAST === 'true'
    },
    
    // Logging
    logLevel: process.env.LOG_LEVEL || "info",
    logFile: process.env.LOG_FILE || "bot.log",
    
    // Auto-reply messages
    autoReplies: {
        greeting: "👋 Hello! I'm a WhatsApp bot. Use " + (process.env.BOT_PREFIX || "!") + "help for commands.",
        busy: "⏳ The bot is currently busy. Please try again later.",
        default: "📩 I received your message. Use " + (process.env.BOT_PREFIX || "!") + "help for available commands."
    },
    
    // Commands configuration
    commands: {
        cooldown: parseInt(process.env.COMMAND_COOLDOWN) || 2000,
        maxLength: parseInt(process.env.MAX_MESSAGE_LENGTH) || 1000
    }
};