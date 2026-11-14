import asyncio
import json
import re
import time
from typing import Any, Dict, List, Optional, Union
from uuid import uuid4

import modal
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

import os

MODEL_ID = os.environ.get("LLM_MODEL", "Qwen/Qwen2.5-7B-Instruct")

# Base Image — reuses PyTorch 2.6.0 CUDA 12.4 runtime
image = (
    modal.Image.from_registry(
        "pytorch/pytorch:2.6.0-cuda12.4-cudnn9-runtime",
        add_python="3.11",
    )
    .env({"HF_HOME": "/opt/huggingface"})
    .pip_install(
        "fastapi==0.115.12",
        "transformers==4.51.3",
        "accelerate==1.6.0",
    )
    .run_commands(
        "python -c \"from huggingface_hub import snapshot_download; "
        "snapshot_download('Qwen/Qwen2.5-7B-Instruct')\""
    )
)

app = modal.App("kikky-chat-server")

_model = None
_tokenizer = None


def _load_model():
    global _model, _tokenizer
    if _model is not None and _tokenizer is not None:
        return _model, _tokenizer

    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    _tokenizer = AutoTokenizer.from_pretrained(MODEL_ID, trust_remote_code=True)
    _model = AutoModelForCausalLM.from_pretrained(
        MODEL_ID,
        torch_dtype=torch.bfloat16,
        device_map="cuda",
        trust_remote_code=True,
    )
    _model.eval()
    return _model, _tokenizer


# --- OpenAI Compatible Schema ---

class FunctionDefinition(BaseModel):
    name: str
    description: Optional[str] = None
    parameters: Optional[Dict[str, Any]] = None


class ToolDefinition(BaseModel):
    type: str = "function"
    function: FunctionDefinition


class ChatMessage(BaseModel):
    role: str
    content: Optional[Union[str, List[Dict[str, Any]]]] = None
    name: Optional[str] = None
    tool_call_id: Optional[str] = None
    tool_calls: Optional[List[Dict[str, Any]]] = None


class ChatCompletionRequest(BaseModel):
    model: Optional[str] = None
    messages: List[ChatMessage]
    tools: Optional[List[ToolDefinition]] = None
    tool_choice: Optional[Union[str, Dict[str, Any]]] = None
    temperature: Optional[float] = 0.2
    max_tokens: Optional[int] = 1024


def _extract_tool_calls(generated_text: str) -> tuple[Optional[str], Optional[List[Dict[str, Any]]]]:
    text = generated_text.replace("</s>", "").replace("<unk>", "").strip()
    raw_calls = None

    # Pattern 1: XML Hermes tags: <tool_call>...</tool_call>
    tool_call_matches = re.findall(r"<tool_call>\s*([\s\S]*?)\s*</tool_call>", text)
    if tool_call_matches:
        raw_calls = []
        for raw in tool_call_matches:
            try:
                parsed = json.loads(raw.strip())
                if isinstance(parsed, dict) and "name" in parsed:
                    raw_calls.append(parsed)
            except Exception:
                fixed = re.sub(r'"arguments":\s*"(\{[\s\S]*?\})"', r'"arguments": \1', raw.strip())
                try:
                    parsed = json.loads(fixed)
                    if isinstance(parsed, dict) and "name" in parsed:
                        raw_calls.append(parsed)
                except Exception:
                    _ignored_error = True
        text = re.sub(r"<tool_call>[\s\S]*?</tool_call>", "", text).strip()

    # Pattern 2: [TOOL_CALLS][{"name": "..."}] — Qwen Hermes fallback prefix format
    if not raw_calls:
        tc_prefix_match = re.search(r'\[TOOL_CALLS\]\s*(\[\s*\{[\s\S]*?"name"[\s\S]*?\}\s*\])', text)
        if tc_prefix_match:
            try:
                candidate = json.loads(tc_prefix_match.group(1))
                if isinstance(candidate, list) and len(candidate) > 0 and all(isinstance(c, dict) and "name" in c for c in candidate):
                    raw_calls = candidate
                    text = (text[:tc_prefix_match.start()] + text[tc_prefix_match.end():]).strip()
            except Exception:
                # Try fixing double-escaped arguments string before giving up
                fixed = re.sub(r'"arguments":\s*"(\{[\s\S]*?\})"', r'"arguments": \1', tc_prefix_match.group(1))
                try:
                    candidate = json.loads(fixed)
                    if isinstance(candidate, list) and len(candidate) > 0 and all(isinstance(c, dict) and "name" in c for c in candidate):
                        raw_calls = candidate
                        text = (text[:tc_prefix_match.start()] + text[tc_prefix_match.end():]).strip()
                except Exception:
                    _ignored_error = True

    # Pattern 3: Direct JSON array [{"name": "..."}]
    if not raw_calls:
        array_match = re.search(r'(\[\s*\{[\s\S]*?"name"[\s\S]*?\}\s*\])', text)
        if array_match:
            try:
                candidate = json.loads(array_match.group(1))
                if isinstance(candidate, list) and len(candidate) > 0 and all(isinstance(c, dict) and "name" in c for c in candidate):
                    raw_calls = candidate
                    text = (text[:array_match.start()] + text[array_match.end():]).strip()
            except Exception:
                _ignored_error = True

    if not raw_calls:
        return (text if text else None), None

    parsed_calls = []
    for call in raw_calls:
        name = call.get("name")
        args = call.get("arguments", {})
        if name:
            parsed_calls.append({
                "id": f"call_{uuid4().hex[:12]}",
                "type": "function",
                "function": {
                    "name": name,
                    "arguments": json.dumps(args) if isinstance(args, dict) else str(args),
                },
            })

    if not parsed_calls:
        return (text if text else None), None

    return (text if text else None), parsed_calls


def _run_inference(payload: ChatCompletionRequest) -> Dict[str, Any]:
    import torch

    model, tokenizer = _load_model()

    # Build tools list for Qwen chat template
    tools_list = None
    if payload.tools and len(payload.tools) > 0 and payload.tool_choice != "none":
        tools_list = [t.function.model_dump() for t in payload.tools]

    # Convert messages for Qwen tokenizer
    formatted_messages = []
    for msg in payload.messages:
        item: Dict[str, Any] = {"role": msg.role}
        if msg.role == "tool":
            item["content"] = msg.content if isinstance(msg.content, str) else json.dumps(msg.content or {})
            if msg.name:
                item["name"] = msg.name
        elif msg.tool_calls:
            tc_blocks = []
            for tc in msg.tool_calls:
                func = tc.get("function", {})
                args = func.get("arguments", "{}")
                if isinstance(args, str):
                    try:
                        args = json.loads(args)
                    except Exception:
                        args = {}
                tc_blocks.append(f"<tool_call>\n{json.dumps({'name': func.get('name'), 'arguments': args})}\n</tool_call>")
            item["content"] = "\n".join(tc_blocks)
        else:
            item["content"] = msg.content or ""
        formatted_messages.append(item)

    if tools_list:
        prompt_text = tokenizer.apply_chat_template(
            formatted_messages,
            tools=tools_list,
            tokenize=False,
            add_generation_prompt=True,
        )
    else:
        prompt_text = tokenizer.apply_chat_template(
            formatted_messages,
            tokenize=False,
            add_generation_prompt=True,
        )
    inputs = tokenizer([prompt_text], return_tensors="pt").to(model.device)

    max_new_tokens = payload.max_tokens or 1024
    temperature = max(0.01, min(float(payload.temperature or 0.2), 2.0))

    with torch.inference_mode():
        generated_ids = model.generate(
            **inputs,
            max_new_tokens=max_new_tokens,
            temperature=temperature,
            do_sample=(temperature > 0.1),
            pad_token_id=tokenizer.eos_token_id,
        )

    input_len = inputs.input_ids.shape[1]
    output_ids = generated_ids[0][input_len:]
    generated_text = tokenizer.decode(output_ids, skip_special_tokens=True)

    text_content, tool_calls = _extract_tool_calls(generated_text)

    message_dict: Dict[str, Any] = {
        "role": "assistant",
        "content": text_content,
    }
    if tool_calls:
        message_dict["tool_calls"] = tool_calls

    completion_id = f"chatcmpl-{uuid4().hex}"
    created_at = int(time.time())

    return {
        "id": completion_id,
        "object": "chat.completion",
        "created": created_at,
        "model": payload.model or MODEL_ID,
        "choices": [
            {
                "index": 0,
                "message": message_dict,
                "finish_reason": "tool_calls" if tool_calls else "stop",
            }
        ],
        "usage": {
            "prompt_tokens": int(input_len),
            "completion_tokens": int(len(output_ids)),
            "total_tokens": int(input_len + len(output_ids)),
        },
    }


# Modal ASGI App with Proxy Authentication (Multi-Lane Concurrent Traffic)
@app.function(
    image=image,
    gpu="A10G",
    timeout=180,
    scaledown_window=300,  # 5 minutes warm keep-alive
)
@modal.asgi_app(requires_proxy_auth=True)
def chat_api():
    api = FastAPI(title="Kikky Agent Chat Server")

    @api.get("/health")
    async def health():
        return {"status": "ok", "model": MODEL_ID}

    @api.get("/v1/models")
    async def list_models():
        return {
            "object": "list",
            "data": [
                {
                    "id": MODEL_ID,
                    "object": "model",
                    "created": int(time.time()),
                    "owned_by": "kikky",
                }
            ],
        }

    @api.post("/chat/completions")
    @api.post("/v1/chat/completions")
    async def chat_completions(payload: ChatCompletionRequest):
        try:
            result = await asyncio.to_thread(_run_inference, payload)
            return result
        except Exception as exc:
            import traceback
            traceback.print_exc()
            raise HTTPException(status_code=500, detail=f"Inference error: {str(exc)}") from exc

    return api
