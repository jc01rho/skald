import { ChatMessage as ChatMessageType, useChatStore } from '@/stores/chatStore'
import { User, Bot } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import { parseContentWithReferences } from '@/components/utils/citationMarkdown'

interface ChatMessageProps {
    message: ChatMessageType
}

export const ChatMessage = ({ message }: ChatMessageProps) => {
    const referencesEnabled = useChatStore((state) => state.ragConfig.referencesEnabled)
    const isUser = message.role === 'user'
    const isAssistant = message.role === 'assistant'
    const isSystem = message.role === 'system'

    const shouldShowReferences = isAssistant && referencesEnabled && message.references

    return (
        <div className={`chat-message ${message.role}`}>
            <div className="message-avatar">
                {isUser && <User size={16} />}
                {isAssistant && <Bot size={16} />}
                {isSystem && <div className="system-icon">!</div>}
            </div>
            <div className="message-content react-markdown">
                {shouldShowReferences ? (
                    parseContentWithReferences(message.content, message.references)
                ) : (
                    <ReactMarkdown>{message.content}</ReactMarkdown>
                )}
                {message.isStreaming && !message.content && <span className="streaming-cursor"></span>}

                <div className="message-timestamp">{message.timestamp.toLocaleTimeString()}</div>
            </div>
        </div>
    )
}
