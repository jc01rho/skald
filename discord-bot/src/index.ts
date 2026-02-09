import { createServer } from 'http'
import { Client, Events, GatewayIntentBits } from 'discord.js'
import { commands, registerCommands } from './commands/index.js'
import { config } from './config.js'
import { handleMention } from './handlers/mentionHandler.js'
import { logger } from './logger.js'

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
})

client.once(Events.ClientReady, async (readyClient) => {
    logger.info(`Logged in as ${readyClient.user.tag}`)
    await registerCommands(client, config.discordBotToken)
})

client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return

    const command = commands.find((cmd) => cmd.data.name === interaction.commandName)
    if (!command) return

    try {
        await command.execute(interaction)
    } catch (error) {
        logger.error({ error }, 'Command execution failed')
        const reply = { content: '명령어 실행 중 오류가 발생했습니다.', ephemeral: true }
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp(reply)
            return
        }
        await interaction.reply(reply)
    }
})

client.on(Events.MessageCreate, async (message) => {
    await handleMention(message, client)
})

process.on('SIGTERM', () => {
    logger.info('SIGTERM received, shutting down...')
    client.destroy()
    process.exit(0)
})

process.on('SIGINT', () => {
    logger.info('SIGINT received, shutting down...')
    client.destroy()
    process.exit(0)
})

const healthServer = createServer((req, res) => {
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok', ready: client.isReady() }))
        return
    }

    res.writeHead(404)
    res.end()
})

healthServer.listen(3000, () => {
    logger.info('Health check server listening on port 3000')
})

client.login(config.discordBotToken).catch((error) => {
    logger.error({ error }, 'Failed to login')
    process.exit(1)
})
