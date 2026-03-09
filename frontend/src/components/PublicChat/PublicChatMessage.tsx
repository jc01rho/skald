import { PublicChatMessage as PublicChatMessageType } from '@/stores/publicChatStore'
import ReactMarkdown from 'react-markdown'
import { parseContentWithReferences } from '@/components/utils/citationMarkdown'

interface PublicChatMessageProps {
    message: PublicChatMessageType
    referencesEnabled?: boolean
}

export const PublicChatMessage = ({ message, referencesEnabled = false }: PublicChatMessageProps) => {
    const isAssistant = message.role === 'assistant'

    const shouldShowReferences = isAssistant && referencesEnabled && message.references

    return (
        <div className={`public-chat-message ${message.role}`}>
            <div className={`public-message-content react-markdown ${isAssistant ? 'assistant-content' : ''}`}>
                {shouldShowReferences ? (
                    parseContentWithReferences(message.content, message.references)
                ) : (
                    <ReactMarkdown>{message.content}</ReactMarkdown>
                )}
                {message.isStreaming && !message.content && <span className="streaming-cursor"></span>}
            </div>
        </div>
    )
}
