import asyncio
import base64
import binascii
import io
import json
import re
import time
from typing import Any
from uuid import UUID, uuid4

import modal

MODEL_ID = "Qwen/Qwen2.5-VL-3B-Instruct"
MAX_ENCODED_BYTES = 16 * 1024 * 1024
MAX_IMAGE_BYTES = 12 * 1024 * 1024
MAX_IMAGE_PIXELS = 40_000_000
MAX_IMAGE_SIDE = 1600

app = modal.App("kikky-vision-classifier")
image = (
    modal.Image.from_registry(
        "pytorch/pytorch:2.6.0-cuda12.4-cudnn9-runtime",
        add_python="3.11",
    )
    .env({"HF_HOME": "/opt/huggingface"})
    .pip_install(
        "fastapi==0.115.12",
        "transformers==4.51.3",
        "qwen-vl-utils==0.0.10",
        "Pillow==11.1.0",
        "accelerate==1.6.0",
    )
    .run_commands(
        "python -c \"from huggingface_hub import snapshot_download; "
        "snapshot_download('Qwen/Qwen2.5-VL-3B-Instruct')\""
    )
)

_model = None
_processor = None

_SAFE_LOG_FIELDS = {
    "stage",
    "outcome",
    "result_type",
    "provider",
    "error_code",
    "fallback_reason",
    "duration_ms",
    "image_bytes",
    "width",
    "height",
    "http_status",
    "confidence",
    "bbox_valid",
    "keyword_count",
    "crop_width",
    "crop_height",
}


def _log_event(event: str, request_id: str, **fields: Any) -> None:
    entry = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "event": event,
        "component": "vision",
        "request_id": request_id,
    }
    for key, value in fields.items():
        if key not in _SAFE_LOG_FIELDS:
            continue
        if key in {"duration_ms", "image_bytes", "width", "height", "http_status", "keyword_count", "crop_width", "crop_height"}:
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                continue
            entry[key] = max(0, min(value, 1_000_000_000))
        elif key == "confidence":
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                continue
            entry[key] = max(0.0, min(float(value), 1.0))
        elif key == "bbox_valid":
            if isinstance(value, bool):
                entry[key] = value
        elif isinstance(value, str) and re.fullmatch(r"[a-zA-Z0-9._:-]{1,80}", value):
            entry[key] = value
    print(json.dumps(entry, separators=(",", ":")), flush=True)


def _normalized_request_id(value: str | None) -> str:
    try:
        return str(UUID(value)) if value else str(uuid4())
    except (ValueError, TypeError, AttributeError):
        return str(uuid4())


def _debug_safe_value(value: Any, depth: int = 0) -> Any:
    if depth >= 3:
        return "[nested value omitted]"
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return max(-1_000_000_000.0, min(float(value), 1_000_000_000.0))
    if isinstance(value, str):
        return value[:200]
    if isinstance(value, list):
        return [_debug_safe_value(item, depth + 1) for item in value[:8]]
    if isinstance(value, dict):
        return {
            str(key)[:60]: _debug_safe_value(item, depth + 1)
            for key, item in list(value.items())[:16]
            if isinstance(key, (str, int, float))
        }
    return f"[{type(value).__name__}]"


def _get_model(request_id: str):
    global _model, _processor
    if _model is None:
        import torch
        from transformers import AutoProcessor, Qwen2_5_VLForConditionalGeneration

        started_at = time.perf_counter()
        _processor = AutoProcessor.from_pretrained(
            MODEL_ID,
            min_pixels=256 * 28 * 28,
            max_pixels=1280 * 28 * 28,
        )
        _model = Qwen2_5_VLForConditionalGeneration.from_pretrained(
            MODEL_ID,
            torch_dtype=torch.bfloat16,
            device_map="cuda:0",
            attn_implementation="sdpa",
        )
        _model.eval()
        _log_event(
            "vision.model.loaded",
            request_id,
            outcome="success",
            duration_ms=(time.perf_counter() - started_at) * 1000,
        )
    return _model, _processor


def _generate_json(image_data: Any, instruction: str, request_id: str, system_prompt: str | None = None) -> dict:
    import torch
    from qwen_vl_utils import process_vision_info

    model, processor = _get_model(request_id)
    messages = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({
        "role": "user",
        "content": [
            {"type": "image", "image": image_data},
            {"type": "text", "text": instruction},
        ],
    })
    prompt = processor.apply_chat_template(
        messages,
        tokenize=False,
        add_generation_prompt=True,
    )
    image_inputs, video_inputs = process_vision_info(messages)
    inputs = processor(
        text=[prompt],
        images=image_inputs,
        videos=video_inputs,
        padding=True,
        return_tensors="pt",
    ).to("cuda:0")

    with torch.inference_mode():
        generated = model.generate(**inputs, max_new_tokens=220, do_sample=False)
    new_tokens = generated[:, inputs.input_ids.shape[1]:]
    text = processor.batch_decode(
        new_tokens,
        skip_special_tokens=True,
        clean_up_tokenization_spaces=False,
    )[0].strip()
    match = re.search(r"\{.*\}", text, flags=re.DOTALL)
    if not match:
        raise ValueError("Model did not return a JSON object")
    value = json.loads(match.group(0))
    if not isinstance(value, dict):
        raise ValueError("Model response was not a JSON object")
    return value


def _load_image(raw: bytes):
    from PIL import Image, ImageOps, UnidentifiedImageError

    if not raw or len(raw) > MAX_IMAGE_BYTES:
        raise ValueError("Image is empty or exceeds the decoded byte limit")

    Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS
    try:
        with Image.open(io.BytesIO(raw)) as opened:
            if opened.format not in {"JPEG", "PNG", "WEBP"}:
                raise ValueError("Only JPEG, PNG, and WebP images are supported")
            opened.verify()
        with Image.open(io.BytesIO(raw)) as opened:
            if opened.width * opened.height > MAX_IMAGE_PIXELS:
                raise ValueError("Image dimensions exceed the pixel limit")
            normalized = ImageOps.exif_transpose(opened).convert("RGB")
            normalized.thumbnail((MAX_IMAGE_SIDE, MAX_IMAGE_SIDE))
            return normalized
    except (UnidentifiedImageError, OSError) as exc:
        raise ValueError("Image could not be decoded") from exc


def _parse_bbox(value: Any, width: int, height: int):
    if not isinstance(value, list) or len(value) != 4:
        return None
    if any(isinstance(part, bool) for part in value):
        return None
    try:
        p1, p2, p3, p4 = (float(part) for part in value)
    except (TypeError, ValueError):
        return None

    if not all(0 <= part <= 1000 for part in (p1, p2, p3, p4)):
        return None

    x_min, x_max = min(p1, p3), max(p1, p3)
    y_min, y_max = min(p2, p4), max(p2, p4)

    if (x_max - x_min) < 5 or (y_max - y_min) < 5:
        return None

    left = int(x_min * width / 1000)
    top = int(y_min * height / 1000)
    right = int(x_max * width / 1000)
    bottom = int(y_max * height / 1000)
    pad_x = max(1, int((right - left) * 0.08))
    pad_y = max(1, int((bottom - top) * 0.08))
    return (
        max(0, left - pad_x),
        max(0, top - pad_y),
        min(width, right + pad_x),
        min(height, bottom + pad_y),
    )


def _find_named_value(value: Any, names: set[str], depth: int = 0):
    if depth > 3:
        return None
    if isinstance(value, dict):
        for key, child in value.items():
            if isinstance(key, str) and key.strip().casefold() in names:
                return child
        for child in value.values():
            found = _find_named_value(child, names, depth + 1)
            if found is not None:
                return found
    elif isinstance(value, list):
        for child in value[:8]:
            found = _find_named_value(child, names, depth + 1)
            if found is not None:
                return found
    return None


def _normalize_product_bbox(result: dict, width: int, height: int):
    candidate = _find_named_value(result, {"bbox", "bbox_2d", "box", "product_bbox", "bounding_box"})
    return _parse_bbox(candidate, width, height)


def _normalize_kind(result: dict) -> str:
    normalized_fields = {
        key.strip().casefold(): value
        for key, value in result.items()
        if isinstance(key, str)
    }
    raw_kind = normalized_fields.get("type")
    if isinstance(raw_kind, str):
        normalized = raw_kind.strip().casefold()
        if normalized in {"product_screenshot", "payment_receipt", "general_media"}:
            return normalized
        if normalized in {"product", "product image", "product screenshot"}:
            return "product_screenshot"
        if normalized in {"receipt", "payment receipt"}:
            return "payment_receipt"

    if any(key in normalized_fields for key in ("physical_intimate_product", "product")):
        return "product_screenshot"
    if any(key in normalized_fields for key in ("payment_receipt", "receipt")):
        return "payment_receipt"
    return "general_media"


def _normalize_confidence(result: dict):
    raw = _find_named_value(result, {"confidence", "score"})
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        return None
    return max(0.0, min(float(raw), 1.0))


def _normalize_keywords(result: dict) -> list[str]:
    raw = _find_named_value(result, {"keywords", "keyword", "descriptors", "visual_descriptors"})
    if isinstance(raw, str):
        raw = [raw]
    if not isinstance(raw, list):
        return []
    return [item.strip()[:60] for item in raw if isinstance(item, str) and item.strip()][:8]


def _number_or_none(value: Any):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if value < 0:
        return None
    return value


def _string_or_none(value: Any, limit: int = 160):
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value[:limit] if value else None


def _debug_pass_summary(value: dict, redact_values: bool = False) -> dict:
    keys = sorted(key[:60] for key in value if isinstance(key, str))[:32]
    summary: dict[str, Any] = {"keys": keys}
    kind = value.get("type")
    if isinstance(kind, str):
        summary["type"] = kind[:80]

    confidence = value.get("confidence")
    if isinstance(confidence, (int, float)) and not isinstance(confidence, bool):
        summary["confidence"] = max(0.0, min(float(confidence), 1.0))
    elif "confidence" in value:
        summary["confidence_type"] = type(confidence).__name__

    if redact_values:
        summary["values_redacted"] = True
        return summary

    for key in ("bbox", "bbox_2d", "box", "product_bbox", "bounding_box"):
        candidate = _find_named_value(value, {key})
        if isinstance(candidate, list) and len(candidate) == 4 and all(
            isinstance(part, (int, float)) and not isinstance(part, bool) for part in candidate
        ):
            summary["bbox_field"] = key
            summary["bbox"] = [max(-1_000_000.0, min(float(part), 1_000_000.0)) for part in candidate]
            break
        if candidate is not None:
            summary["bbox_field"] = key
            summary["bbox_value_type"] = type(candidate).__name__
            if isinstance(candidate, dict):
                summary["bbox_value_keys"] = sorted(str(field)[:60] for field in candidate)[:16]
            break

    product_key = next((
        key for key in value
        if isinstance(key, str) and key.strip().casefold() in {"physical_intimate_product", "product", "product_name", "name"}
    ), None)
    if product_key is not None:
        summary["product_field"] = product_key
        summary["product_value"] = _debug_safe_value(value[product_key])
    keywords = value.get("keywords")
    if isinstance(keywords, list):
        summary["keywords"] = [word.strip()[:60] for word in keywords if isinstance(word, str) and word.strip()][:8]
    return summary


FIRST_PASS_SYSTEM_PROMPT = (
    "You are Kikky's visual classification engine for e-commerce and payments. "
    "You must output strictly valid JSON conforming to the requested schema. "
    "Never output conversational text, markdown formatting, or unrequested keys."
)

FIRST_PASS_INSTRUCTION = (
    "Classify this image into one of three categories:\n"
    "1. \"product_screenshot\": An image, photo, or screenshot showing a physical retail product (e.g. adult wellness items, dildos, vibrators, massagers, lubricants, lingerie, toys). Even if held by a person, shown in a hand, or displayed in real-world use, if an adult wellness or retail product is present, classify as \"product_screenshot\".\n"
    "2. \"payment_receipt\": A screenshot or photo of a bank transfer receipt or payment confirmation (e.g. OPAY, PalmPay, Moniepoint, Kuda, bank transfer slips).\n"
    "3. \"general_media\": Any other image containing no retail products or payment slips (e.g. regular personal selfies without products, general memes, outdoor landscapes, text chats).\n\n"
    "If product_screenshot, detect the primary physical product and output its bounding box as \"bbox_2d\": [x1, y1, x2, y2] normalized between 0 and 1000 relative to full image width and height, where (x1, y1) is top-left and (x2, y2) is bottom-right. Focus the bounding box directly on the product itself. If multiple items form one product set, enclose the full set. Ignore social media buttons, watermarks, likes, comments, and price overlays.\n\n"
    "If payment_receipt, extract unverified candidate fields: \"amount\" (number or null), \"bank\" (string or null), \"sender\" (string or null), \"date\" (string or null).\n\n"
    "Return strictly one JSON object matching this schema:\n"
    "{\"type\":\"product_screenshot\"|\"payment_receipt\"|\"general_media\",\"confidence\":0.0 to 1.0,\"bbox_2d\":[x1,y1,x2,y2],\"product_name\":\"short visible name\"}"
)

SECOND_PASS_SYSTEM_PROMPT = (
    "You are an e-commerce catalog search indexing engine. Extract concise, searchable product keywords from the image crop. Output strictly valid JSON."
)

SECOND_PASS_INSTRUCTION = (
    "Identify the physical product in this cropped image.\n"
    "Provide 2 to 6 short, high-precision search keywords (e.g. product category, common product name, primary material, shape).\n"
    "Rules:\n"
    "- Each keyword must be 1 to 3 words maximum (e.g. \"rose vibrator\", \"bullet massager\", \"silicone wand\").\n"
    "- Do not include conversational filler, subjective opinions, or inferred medical claims.\n"
    "- Ignore background artifacts or cut-off text.\n\n"
    "Return strictly JSON:\n"
    "{\"keywords\":[\"keyword 1\",\"keyword 2\"]}"
)


def classify_image_bytes(raw: bytes, request_id: str | None = None, debug: bool = False) -> dict:
    from PIL import Image

    request_id = _normalized_request_id(request_id)
    started_at = time.perf_counter()
    _log_event("vision.request.started", request_id, image_bytes=len(raw))
    full_image = _load_image(raw)
    _log_event("vision.image.prepared", request_id, width=full_image.width, height=full_image.height)

    def run_pass(image_data: Any, instruction: str, stage: str, system_prompt: str | None = None) -> dict:
        pass_started_at = time.perf_counter()
        _log_event("vision.pass.started", request_id, stage=stage)
        try:
            value = _generate_json(image_data, instruction, request_id, system_prompt=system_prompt)
        except Exception as exc:
            _log_event(
                "vision.pass.failed",
                request_id,
                stage=stage,
                outcome="error",
                error_code=type(exc).__name__,
                duration_ms=(time.perf_counter() - pass_started_at) * 1000,
            )
            raise
        _log_event(
            "vision.pass.completed",
            request_id,
            stage=stage,
            outcome="success",
            duration_ms=(time.perf_counter() - pass_started_at) * 1000,
        )
        return value

    first_pass = run_pass(
        full_image,
        FIRST_PASS_INSTRUCTION,
        "classify_full_image",
        system_prompt=FIRST_PASS_SYSTEM_PROMPT,
    )
    debug_output: dict[str, Any] = {}
    kind_hint = _normalize_kind(first_pass)
    debug_output["first_pass"] = _debug_pass_summary(
        first_pass,
        redact_values=kind_hint == "payment_receipt",
    )

    kind = kind_hint
    confidence = _normalize_confidence(first_pass)
    bbox = _normalize_product_bbox(first_pass, full_image.width, full_image.height) if kind == "product_screenshot" else None
    _log_event(
        "vision.pass.decision",
        request_id,
        stage="classify_full_image",
        result_type=kind,
        confidence=confidence,
        bbox_valid=bbox is not None,
    )

    def finish(result: dict, fallback_reason: str | None = None) -> dict:
        outcome = "success" if result.get("ok") is not False else "error"
        _log_event(
            "vision.request.completed",
            request_id,
            outcome=outcome,
            result_type=result.get("type", "unknown"),
            fallback_reason=fallback_reason,
            confidence=confidence,
            keyword_count=len(result.get("keywords", [])),
            duration_ms=(time.perf_counter() - started_at) * 1000,
        )
        if debug:
            result["debug"] = debug_output
        return result

    if kind == "payment_receipt":
        return finish({
            "type": "payment_receipt",
            "amount": _number_or_none(first_pass.get("amount")),
            "bank": _string_or_none(first_pass.get("bank"), 120),
            "sender": _string_or_none(first_pass.get("sender")),
            "date": _string_or_none(first_pass.get("date"), 80),
            "confidence": confidence if confidence is not None else 0.0,
            "verified": False,
        })

    if kind == "general_media":
        return finish({"type": "general_media"}, "not_product_screenshot")

    if confidence is not None and confidence < 0.5:
        return finish({"type": "general_media"}, "low_confidence")

    if bbox is None:
        _log_event("vision.pass.failed", request_id, stage="product_crop", outcome="error", error_code="invalid_or_missing_bbox")
        return finish({
            "ok": False,
            "error": "Product detected but bounding box was invalid or missing",
            "error_code": "invalid_or_missing_bbox",
            "type": "product_screenshot",
        }, "invalid_or_missing_bbox")

    crop_w = bbox[2] - bbox[0]
    crop_h = bbox[3] - bbox[1]
    _log_event("vision.crop.created", request_id, stage="product_crop", width=crop_w, height=crop_h)
    crop = full_image.crop(bbox)
    keyword_result = run_pass(
        crop,
        SECOND_PASS_INSTRUCTION,
        "extract_crop_keywords",
        system_prompt=SECOND_PASS_SYSTEM_PROMPT,
    )
    debug_output["second_pass"] = _debug_pass_summary(keyword_result)
    clean_keywords = _normalize_keywords(keyword_result)
    if not clean_keywords:
        _log_event("vision.pass.failed", request_id, stage="extract_crop_keywords", outcome="error", error_code="no_keywords")
        return finish({
            "ok": False,
            "error": "Product detected but keyword extraction returned empty",
            "error_code": "no_keywords",
            "type": "product_screenshot",
        }, "no_keywords")

    product_result = {
        "type": "product_screenshot",
        "keywords": clean_keywords,
    }
    if confidence is not None:
        product_result["confidence"] = confidence
    return finish(product_result)


from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field


class ImageRequest(BaseModel):
    image_base64: str = Field(min_length=12, max_length=MAX_ENCODED_BYTES)
    request_id: str | None = Field(default=None, min_length=36, max_length=36)
    debug: bool = False


@app.function(
    image=image,
    gpu="A10G",
    timeout=180,
    scaledown_window=120,
)
@modal.concurrent(max_inputs=1)
@modal.asgi_app(requires_proxy_auth=True)
def vision_api():
    api = FastAPI()

    @api.post("/classify")
    async def classify(payload: ImageRequest):
        request_id = _normalized_request_id(payload.request_id)
        started_at = time.perf_counter()
        try:
            raw = base64.b64decode(payload.image_base64, validate=True)
            if len(raw) > MAX_IMAGE_BYTES:
                raise HTTPException(status_code=413, detail="Image exceeds the decoded byte limit")
            _log_event("vision.http.accepted", request_id, image_bytes=len(raw))
            result = await asyncio.to_thread(classify_image_bytes, raw, request_id, payload.debug)
            debug_output = result.pop("debug", None) if payload.debug else None
            _log_event(
                "vision.http.completed",
                request_id,
                outcome="success" if result.get("ok") is not False else "error",
                result_type=result.get("type"),
                duration_ms=(time.perf_counter() - started_at) * 1000,
            )
            if result.get("ok") is False:
                response = {
                    "ok": False,
                    "error": result.get("error", "Vision classification failed"),
                    "error_code": result.get("error_code"),
                }
            else:
                response = {"ok": True, "data": result}
            if debug_output is not None:
                response["debug"] = debug_output
            return response
        except HTTPException as exc:
            _log_event("vision.http.rejected", request_id, outcome="error", http_status=exc.status_code, error_code="request_rejected", duration_ms=(time.perf_counter() - started_at) * 1000)
            raise
        except (binascii.Error, ValueError) as exc:
            _log_event("vision.http.rejected", request_id, outcome="error", http_status=400, error_code=type(exc).__name__, duration_ms=(time.perf_counter() - started_at) * 1000)
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:
            _log_event("vision.http.failed", request_id, outcome="error", error_code=type(exc).__name__, duration_ms=(time.perf_counter() - started_at) * 1000)
            return {"ok": False, "error": "Image classification failed"}

    return api
