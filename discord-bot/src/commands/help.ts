import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js'

export const data = new SlashCommandBuilder().setName('help').setDescription('Skald 봇 사용법을 안내합니다')

export async function execute(interaction: ChatInputCommandInteraction) {
    const embed = new EmbedBuilder()
        .setTitle('🤖 Skald Bot 도움말')
        .setDescription('Skald RAG API를 활용한 Q&A 봇입니다.')
        .addFields(
            { name: '사용법', value: '봇을 멘션하고 질문하세요!\n예: `@Skald Bot 우리 프로젝트의 아키텍처는?`' },
            { name: '명령어', value: '`/help` - 이 도움말\n`/config` - 현재 설정 확인' }
        )
        .setColor(0x5865f2)

    await interaction.reply({ embeds: [embed] })
}
