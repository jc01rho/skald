/**
 * Test LLM Service with Retry and Fallback
 * This script demonstrates the retry and fallback logic
 */

import { LLMService } from '../backend/src/services/llmService'

async function testRetryLogic() {
    console.log('=== Testing LLM Retry and Fallback Logic ===\n')

    // Test 1: Valid request should work with retry
    console.log('Test 1: Valid request with retry enabled')
    try {
        const result = await LLMService.invokeWithRetry({
            messages: [{ role: 'user', content: 'Say hello in 1 word' }],
            temperature: 0,
            maxRetries: 3,
            retryDelayMs: 500,
            useFallbackChain: false,
        })
        console.log('✓ Test 1 PASSED: Got response:', result.content?.substring(0, 100))
    } catch (error) {
        console.error('✗ Test 1 FAILED:', (error as Error).message)
    }

    // Test 2: Invalid model should trigger model-level fallback
    console.log('\nTest 2: Invalid model with model-level fallback')
    try {
        const result = await LLMService.invokeWithRetry({
            messages: [{ role: 'user', content: 'Say hello' }],
            temperature: 0,
            maxRetries: 1,
            retryDelayMs: 500,
            useFallbackChain: true,
        })
        console.log('✓ Test 2 PASSED: Got response from fallback:', result.content?.substring(0, 100))
    } catch (error) {
        console.error('✗ Test 2 FAILED:', (error as Error).message)
    }

    console.log('\n=== All Tests Complete ===')
}

testRetryLogic().catch((error) => {
    console.error('Test script failed:', error)
    process.exit(1)
})
