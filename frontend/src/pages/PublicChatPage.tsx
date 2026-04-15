import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { AlertCircle, Loader2 } from 'lucide-react'
import { api } from '@/lib/api'
import { PublicChat } from '@/components/PublicChat/PublicChat'
import { usePublicChatStore } from '@/stores/publicChatStore'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'

interface PublicChatConfig {
    logo_url: string | null
    title: string | null
}

export const PublicChatPage = () => {
    const { slug } = useParams<{ slug: string }>()
    const [isChecking, setIsChecking] = useState(true)
    const [isAvailable, setIsAvailable] = useState(false)
    const [config, setConfig] = useState<PublicChatConfig | null>(null)
    const [errorMessage, setErrorMessage] = useState<string | null>(null)
    const clearMessages = usePublicChatStore((state) => state.clearMessages)

    useEffect(() => {
        // Clear messages when component mounts or slug changes
        clearMessages()
    }, [slug, clearMessages])

    useEffect(() => {
        if (!slug) {
            setIsChecking(false)
            setIsAvailable(false)
            return
        }

        const checkAvailabilityAndLoadConfig = async () => {
            setErrorMessage(null)
            try {
                const [availabilityResponse, configResponse] = await Promise.all([
                    api.get<{ available: boolean }>(`/public_chat/${slug}/available`),
                    api.get<PublicChatConfig>(`/public_chat/${slug}/config`).catch(() => null),
                ])

                if (availabilityResponse.data?.available) {
                    setIsAvailable(true)
                    if (configResponse?.data) {
                        setConfig(configResponse.data)
                    }
                } else {
                    setIsAvailable(false)
                }
            } catch (error) {
                console.error('Error checking availability:', error)
                setIsAvailable(false)
                setErrorMessage('공개 chat 페이지를 불러오지 못했습니다.')
            } finally {
                setIsChecking(false)
            }
        }

        checkAvailabilityAndLoadConfig()
    }, [slug])

    if (!slug) {
        return (
            <div className="mx-auto flex min-h-screen w-full max-w-4xl items-center px-4 py-8 sm:px-6 lg:px-8">
                <Alert variant="destructive" className="max-w-3xl">
                    <AlertCircle className="h-4 w-4" />
                    <AlertTitle>유효하지 않은 공개 chat 링크입니다</AlertTitle>
                    <AlertDescription>공개 chat을 보려면 올바른 slug가 필요합니다.</AlertDescription>
                </Alert>
            </div>
        )
    }

    if (isChecking) {
        return (
            <div className="flex items-center justify-center min-h-screen">
                <Loader2 className="h-8 w-8 animate-spin" />
            </div>
        )
    }

    if (!isAvailable) {
        return (
            <div className="mx-auto flex min-h-screen w-full max-w-4xl items-center px-4 py-8 sm:px-6 lg:px-8">
                <Alert variant="destructive" className="max-w-3xl">
                    <AlertCircle className="h-4 w-4" />
                    <AlertTitle>공개 chat 페이지를 찾을 수 없습니다</AlertTitle>
                    <AlertDescription>
                        {errorMessage || '이 slug는 아직 활성화되지 않았거나 접근할 수 없습니다.'}
                    </AlertDescription>
                </Alert>
            </div>
        )
    }

    return (
        <div className="flex flex-col h-screen overflow-hidden">
            <PublicChat slug={slug} logoUrl={config?.logo_url} title={config?.title} />
        </div>
    )
}
