import * as help from './help.js'
import * as config from './config.js'
import { Client, REST, Routes } from 'discord.js'

export const commands = [help, config]

export async function registerCommands(client: Client, token: string) {
    const rest = new REST().setToken(token)

    const commandData = commands.map((cmd) => cmd.data.toJSON())

    await rest.put(Routes.applicationCommands(client.user!.id), { body: commandData })

    console.log('Slash commands registered')
}
