import asyncio
import httpx
import json

LOCAL_LLM_ENDPOINTS = [
    {
        "name": "kanana-local",
        "url": "http://192.168.150.37:8889/chat/completions",
        "type": "openai-compatible",
        "model": None,
    },
    {
        "name": "ollama-kanana",
        "url": "http://192.168.30.169:11434",
        "type": "ollama",
        "model": "cookieshake/kanana-1.5-8b-instruct-2505:Q4_K_M",
    },
]

async def test_endpoint(endpoint):
    name = endpoint["name"]
    url = endpoint["url"]
    endpoint_type = endpoint["type"]
    model = endpoint.get("model")
    
    print(f"\n{'='*60}")
    print(f"Testing: {name}")
    print(f"URL: {url}")
    print(f"Type: {endpoint_type}")
    print(f"Model: {model or 'N/A'}")
    print(f"{'='*60}")
    
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            if endpoint_type == "openai-compatible":
                payload = {
                    "messages": [{"role": "user", "content": "Say hello in one word."}],
                    "max_tokens": 10
                }
                response = await client.post(
                    url,
                    json=payload,
                    headers={"Content-Type": "application/json"}
                )
                
                if response.status_code == 200:
                    data = response.json()
                    if "choices" in data:
                        content = data["choices"][0]["message"]["content"]
                        print(f"✅ SUCCESS!")
                        print(f"Response: {content[:100]}")
                    else:
                        print(f"✅ Response received (non-standard format)")
                        print(f"Data: {str(data)[:200]}")
                else:
                    print(f"❌ HTTP Error: {response.status_code}")
                    print(f"Response: {response.text[:200]}")
                    
            elif endpoint_type == "ollama":
                # First check if Ollama is running
                health_url = f"{url}/api/tags"
                health_response = await client.get(health_url)
                
                if health_response.status_code != 200:
                    print(f"❌ Ollama not reachable at {url}")
                    print(f"Status: {health_response.status_code}")
                    return
                
                models = health_response.json().get("models", [])
                print(f"Available models: {[m['name'] for m in models][:5]}...")
                
                # Test chat
                chat_url = f"{url}/api/chat"
                payload = {
                    "model": model,
                    "messages": [{"role": "user", "content": "Say hello in one word."}],
                    "stream": False,
                    "options": {"num_predict": 10}
                }
                
                response = await client.post(
                    chat_url,
                    json=payload,
                    headers={"Content-Type": "application/json"}
                )
                
                if response.status_code == 200:
                    data = response.json()
                    if "message" in data:
                        content = data["message"].get("content", "")
                        print(f"✅ SUCCESS!")
                        print(f"Response: {content[:100]}")
                    else:
                        print(f"✅ Response received")
                        print(f"Data: {str(data)[:200]}")
                else:
                    print(f"❌ HTTP Error: {response.status_code}")
                    print(f"Response: {response.text[:200]}")
                    
    except httpx.ConnectError as e:
        print(f"❌ CONNECTION FAILED: Cannot connect to {url}")
        print(f"Error: {str(e)[:200]}")
    except httpx.TimeoutException:
        print(f"❌ TIMEOUT: Request timed out after 30s")
    except Exception as e:
        print(f"❌ ERROR: {type(e).__name__}: {str(e)[:200]}")

async def main():
    print("Testing Local LLM Endpoints...")
    for endpoint in LOCAL_LLM_ENDPOINTS:
        await test_endpoint(endpoint)
    print("\n" + "="*60)
    print("Test Complete")

asyncio.run(main())
