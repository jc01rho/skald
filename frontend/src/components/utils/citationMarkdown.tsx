import ReactMarkdown from 'react-markdown'
import { ReferenceLink } from '@/components/Playground/ReferenceLink'

type ReferencesMap = Record<number, { memo_uuid: string; memo_title: string }>

function normalizeCitationSpacing(text: string): string {
    return text
        .replace(/(\[\[\d+\]\])(?=\[\[\d+\]\])/g, '$1 ')
        .replace(/(\[\d+\])(?=\[\d+\])/g, '$1 ')
        .replace(/([\p{L}\p{N}])(\[\[(\d+)\]\]|\[(\d+)\])/gu, '$1 $2')
        .replace(/(\[\[(\d+)\]\]|\[(\d+)\])([\p{L}\p{N}])/gu, '$1 $4')
}

function processTextWithReferences(text: string, references: ReferencesMap): any[] {
    const parts: any[] = []
    const regex = /\[\[(\d+)\]\]|\[(\d+)\]/g
    let lastIndex = 0
    let match: RegExpExecArray | null

    while ((match = regex.exec(text)) !== null) {
        if (match.index > lastIndex) {
            parts.push(text.slice(lastIndex, match.index))
        }

        const citationKey = match[1] ?? match[2]
        const index = parseInt(citationKey, 10)
        const reference = references[index]

        if (reference) {
            parts.push(
                <ReferenceLink
                    key={`ref-${index}-${match.index}`}
                    index={index}
                    memo_uuid={reference.memo_uuid}
                    memo_title={reference.memo_title}
                />
            )
        } else {
            parts.push(`[${citationKey}]`)
        }

        lastIndex = regex.lastIndex
    }

    if (lastIndex < text.length) {
        parts.push(text.slice(lastIndex))
    }

    return parts.length > 0 ? parts : [text]
}

function processChildren(children: any, references: ReferencesMap): any {
    if (typeof children === 'string') {
        return processTextWithReferences(children, references)
    }

    if (Array.isArray(children)) {
        return children.map((child) => processChildren(child, references)).flat()
    }

    return children
}

export function parseContentWithReferences(content: string, references?: ReferencesMap) {
    if (!references || Object.keys(references).length === 0) {
        return <ReactMarkdown>{content}</ReactMarkdown>
    }

    const normalizedContent = normalizeCitationSpacing(content)

    const components = {
        p: ({ children }: any) => <p>{processChildren(children, references)}</p>,
        li: ({ children }: any) => <li>{processChildren(children, references)}</li>,
        strong: ({ children }: any) => <strong>{processChildren(children, references)}</strong>,
        em: ({ children }: any) => <em>{processChildren(children, references)}</em>,
        code: ({ children }: any) => <code>{processChildren(children, references)}</code>,
    }

    return <ReactMarkdown components={components}>{normalizedContent}</ReactMarkdown>
}
