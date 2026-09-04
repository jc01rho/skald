import { getDefaultLLMModels, SUPPORTED_LLM_MODELS } from '../llmModels'
import { reloadLLMConfig } from '../settings'

describe('llmModels', () => {
    const originalChatModel = process.env.LLM_DEFAULT_CHAT_MODEL
    const originalClassificationModel = process.env.LLM_DEFAULT_CLASSIFICATION_MODEL
    const originalFallbackChain = process.env.LLM_FALLBACK_CHAIN

    afterEach(() => {
        process.env.LLM_DEFAULT_CHAT_MODEL = originalChatModel
        process.env.LLM_DEFAULT_CLASSIFICATION_MODEL = originalClassificationModel
        process.env.LLM_FALLBACK_CHAIN = originalFallbackChain
        reloadLLMConfig()
    })

    it('includes glm in supported cli-proxy-api models', () => {
        const models = SUPPORTED_LLM_MODELS['cli-proxy-api']
        expect(models.glm).toEqual({ slug: 'glm', name: 'GLM' })
        expect(Object.hasOwn(models, 'glm-5.2')).toBe(false)
    })

    it('resolves glm as the default chat and classification model', () => {
        process.env.LLM_DEFAULT_CHAT_MODEL = 'glm'
        process.env.LLM_DEFAULT_CLASSIFICATION_MODEL = 'glm'
        process.env.LLM_FALLBACK_CHAIN = 'glm,parrot'
        reloadLLMConfig()

        const models = getDefaultLLMModels()

        expect(models['cli-proxy-api'].defaultChatModel.slug).toBe('glm')
        expect(models['cli-proxy-api'].defaultClassificationModel.slug).toBe('glm')
    })
})
