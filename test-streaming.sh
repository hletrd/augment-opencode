#!/bin/bash

# Test streaming with a simple request to see the order of chunks
echo "Testing streaming response with thinking chunks..."
echo ""

curl -s -X POST http://localhost:8765/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-haiku-4-5",
    "messages": [{"role": "user", "content": "What is 2+2? Think step by step."}],
    "stream": true
  }' | while IFS= read -r line; do
  if [[ $line == data:* ]]; then
    # Extract the JSON part
    json_part="${line#data: }"
    if [[ $json_part != "[DONE]" ]]; then
      # Check if it contains reasoning_content or content
      if echo "$json_part" | grep -q "reasoning_content"; then
        echo "🧠 THINKING: $(echo "$json_part" | jq -r '.choices[0].delta.reasoning_content // empty' 2>/dev/null | head -c 80)"
      elif echo "$json_part" | grep -q '"content"'; then
        echo "💬 MESSAGE: $(echo "$json_part" | jq -r '.choices[0].delta.content // empty' 2>/dev/null | head -c 80)"
      fi
    fi
  fi
done

echo ""
echo "Test complete!"

