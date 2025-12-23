#!/bin/bash

echo "============================================================"
echo "Testing Local LLM Endpoints"
echo "============================================================"

echo ""
echo "1. Testing kanana-local (http://192.168.150.37:8889/chat/completions)"
echo "------------------------------------------------------------"
curl -s -m 30 -X POST http://192.168.150.37:8889/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "Say hello in Korean"}], "max_tokens": 20}' \
  | head -c 500

echo ""
echo ""
echo "2. Testing ollama-kanana health (http://192.168.30.169:11434/api/tags)"
echo "------------------------------------------------------------"
curl -s -m 10 http://192.168.30.169:11434/api/tags | head -c 500

echo ""
echo ""
echo "3. Testing ollama-kanana chat (http://192.168.30.169:11434/api/chat)"
echo "------------------------------------------------------------"
curl -s -m 60 -X POST http://192.168.30.169:11434/api/chat \
  -H "Content-Type: application/json" \
  -d '{"model": "cookieshape/kanana-1.5-8b-instruct-2505:Q4_K_M", "messages": [{"role": "user", "content": "Say hello in Korean"}], "stream": false, "options": {"num_predict": 20}}' \
  | head -c 500

echo ""
echo ""
echo "============================================================"
echo "Test Complete"
echo "============================================================"
