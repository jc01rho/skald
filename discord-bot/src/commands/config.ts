import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js'
import { config } from '../config.js'

export const data = new SlashCommandBuilder().setName('config').setDescription('현재 봇 설정을 확인합니다')

export async function execute(interaction: ChatInputCommandInteraction) {
    const embed = new EmbedBuilder()
        .setTitle('⚙️ 봇 설정')
        .addFields(
            { name: 'API URL', value: config.skaldApiUrl, inline: true },
            { name: 'Project ID', value: config.skaldProjectId, inline: true },
            { name: 'Log Level', value: config.logLevel, inline: true }
        )
        .setColor(0x5865f2)

    await interaction.reply({ embeds: [embed], ephemeral: true })
}
