import contextlib
import importlib.util
import io
import json
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image


class FakeImage:
    @classmethod
    def from_registry(cls, *args, **kwargs):
        return cls()

    def env(self, *args, **kwargs):
        return self

    def pip_install(self, *args, **kwargs):
        return self

    def run_commands(self, *args, **kwargs):
        return self


class FakeApp:
    def __init__(self, *args, **kwargs):
        self.args = args
        self.kwargs = kwargs

    def function(self, *args, **kwargs):
        return lambda function: function


fake_modal = types.SimpleNamespace(
    App=FakeApp,
    Image=FakeImage,
    concurrent=lambda *args, **kwargs: lambda function: function,
    asgi_app=lambda *args, **kwargs: lambda function: function,
)
modal_path = Path(__file__).resolve().parents[1] / "modal" / "vision_server.py"
spec = importlib.util.spec_from_file_location("vision_server_logging_test_target", modal_path)
vision_server = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, {"modal": fake_modal}):
    spec.loader.exec_module(vision_server)


def make_png():
    image = Image.new("RGB", (640, 480), "white")
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def parse_logs(output):
    return [json.loads(line) for line in output.splitlines() if line.startswith("{")]


class VisionServerLoggingTests(unittest.TestCase):
    def test_canonical_prompt_output_is_requested(self):
        request_id = "e1234567-1234-4234-8234-123456789abc"
        prompts = []

        def fake_generate(_image, instruction, _request_id, **_kwargs):
            prompts.append(instruction)
            return {"type": "general_media"}

        with patch.object(vision_server, "_generate_json", side_effect=fake_generate):
            vision_server.classify_image_bytes(make_png(), request_id)

        self.assertIn('"bbox_2d":[x1,y1,x2,y2]', prompts[0])
        self.assertIn('"product_name":"short literal item name"', prompts[0])
        self.assertIn('"payment_receipt"', prompts[0])
        self.assertIn('"product_screenshot"', prompts[0])

    def test_observed_nested_bbox_2d_and_missing_confidence_runs_second_pass(self):
        request_id = "f1234567-1234-4234-8234-123456789abc"
        responses = iter([
            {
                "type": "product_screenshot",
                "physical_intimate_product": {
                    "bbox_2d": [93, 458, 267, 718],
                    "name": "Rose + Bullet Duo",
                },
            },
            {"keywords": ["rose-shaped vibrator", "black bullet vibrator"]},
        ])
        prompts = []

        def fake_generate(_image, instruction, _request_id, **_kwargs):
            prompts.append(instruction)
            return next(responses)

        with patch.object(vision_server, "_generate_json", side_effect=fake_generate) as generate:
            result = vision_server.classify_image_bytes(make_png(), request_id, debug=True)

        self.assertEqual(generate.call_count, 2)
        self.assertIn("Identify the physical product in this cropped image", prompts[1])
        self.assertEqual(result["type"], "product_screenshot")
        self.assertNotIn("confidence", result)
        # product_name from first pass ("rose + bullet duo") is prepended as the first keyword
        self.assertEqual(result["keywords"], ["rose + bullet duo", "rose-shaped vibrator", "black bullet vibrator"])
        self.assertEqual(result["debug"]["first_pass"]["product_value"]["bbox_2d"], [93, 458, 267, 718])

    def test_capitalized_product_and_keywords_are_normalized(self):
        request_id = "91234567-1234-4234-8234-123456789abc"
        responses = iter([
            {
                "Product": {
                    "bbox_2d": [93, 458, 267, 718],
                    "name": "Rose + Bullet Duo",
                },
                "Other": "The upper panel shows an iPhone.",
            },
            {"Keywords": ["rose-shaped vibrator", "black bullet vibrator"]},
        ])

        with patch.object(vision_server, "_generate_json", side_effect=lambda *args, **kwargs: next(responses)) as generate:
            result = vision_server.classify_image_bytes(make_png(), request_id)

        self.assertEqual(generate.call_count, 2)
        self.assertEqual(result, {
            "type": "product_screenshot",
            "keywords": ["rose + bullet duo", "rose-shaped vibrator", "black bullet vibrator"],
        })

    def test_product_and_bbox_keys_allow_case_and_whitespace_variants(self):
        request_id = "a2234567-1234-4234-8234-123456789abc"
        responses = iter([
            {" Product ": {" BBOX_2D ": [93, 458, 267, 718], "name": "Rose + Bullet Duo"}},
            {" Keywords ": ["rose", "bullet"]},
        ])

        with patch.object(vision_server, "_generate_json", side_effect=lambda *args, **kwargs: next(responses)) as generate:
            result = vision_server.classify_image_bytes(make_png(), request_id)

        self.assertEqual(generate.call_count, 2)
        self.assertEqual(result["type"], "product_screenshot")
        self.assertEqual(result["keywords"], ["rose + bullet duo", "rose", "bullet"])

    def test_product_image_logs_both_passes_without_keywords_or_prompt(self):
        request_id = "a1234567-1234-4234-8234-123456789abc"
        responses = iter([
            {"type": "product_screenshot", "confidence": 0.92, "bbox": [250, 250, 750, 750]},
            {"keywords": ["private rose massager name"]},
        ])
        output = io.StringIO()

        with patch.object(vision_server, "_generate_json", side_effect=lambda *args, **kwargs: next(responses)) as generate:
            with contextlib.redirect_stdout(output):
                result = vision_server.classify_image_bytes(make_png(), request_id, debug=True)

        self.assertEqual(result["type"], "product_screenshot")
        self.assertEqual(generate.call_count, 2)
        logs = parse_logs(output.getvalue())
        pass_starts = [item["stage"] for item in logs if item["event"] == "vision.pass.started"]
        self.assertEqual(pass_starts, ["classify_full_image", "extract_crop_keywords"])
        self.assertEqual({item["request_id"] for item in logs}, {request_id})
        self.assertEqual(logs[-1]["event"], "vision.request.completed")
        self.assertEqual(logs[-1]["keyword_count"], 1)
        self.assertNotIn("private rose massager name", output.getvalue())
        self.assertNotIn("Identify the physical product", output.getvalue())
        self.assertEqual(result["debug"]["first_pass"]["bbox"], [250.0, 250.0, 750.0, 750.0])
        self.assertEqual(result["debug"]["second_pass"]["keywords"], ["private rose massager name"])

    def test_product_description_alias_is_available_for_debug(self):
        summary = vision_server._debug_pass_summary({
            "type": "product_screenshot",
            "physical_intimate_product": {"name": "red rose massager", "items": ["rose", "bullet"]},
        })
        self.assertEqual(summary["product_field"], "physical_intimate_product")
        self.assertEqual(summary["product_value"]["name"], "red rose massager")
        self.assertEqual(summary["product_value"]["items"], ["rose", "bullet"])

    def test_general_media_debug_shows_first_pass_reason_without_model_prompt(self):
        request_id = "b1234567-1234-4234-8234-123456789abc"
        output = io.StringIO()

        with patch.object(vision_server, "_generate_json", return_value={"type": "general_media"}) as generate:
            with contextlib.redirect_stdout(output):
                result = vision_server.classify_image_bytes(make_png(), request_id, debug=True)

        self.assertEqual(result["type"], "general_media")
        self.assertEqual(generate.call_count, 1)
        logs = parse_logs(output.getvalue())
        self.assertEqual(logs[-1]["fallback_reason"], "not_product_screenshot")
        self.assertNotIn("image_base64", output.getvalue())
        self.assertEqual(result["debug"]["first_pass"]["type"], "general_media")
        self.assertNotIn("second_pass", result["debug"])

    def test_receipt_debug_redacts_extracted_values(self):
        request_id = "c1234567-1234-4234-8234-123456789abc"
        model_output = {
            "type": "payment_receipt",
            "amount": 45000,
            "bank": "Private Bank",
            "sender": "Private Sender",
            "date": "2026-11-13",
            "confidence": 0.9,
        }
        with patch.object(vision_server, "_generate_json", return_value=model_output):
            result = vision_server.classify_image_bytes(make_png(), request_id, debug=True)

        debug_text = json.dumps(result["debug"])
        self.assertTrue(result["debug"]["first_pass"]["values_redacted"])
        self.assertNotIn("Private Bank", debug_text)
        self.assertNotIn("Private Sender", debug_text)
        self.assertNotIn("45000", debug_text)

    def test_debug_is_absent_when_not_requested(self):
        request_id = "d1234567-1234-4234-8234-123456789abc"
        with patch.object(vision_server, "_generate_json", return_value={"type": "general_media"}):
            result = vision_server.classify_image_bytes(make_png(), request_id)
        self.assertNotIn("debug", result)

    def test_product_missing_bbox_returns_explicit_error(self):
        request_id = "d2234567-1234-4234-8234-123456789abc"
        responses = iter([
            {"type": "product_screenshot", "confidence": 0.95},
        ])
        with patch.object(vision_server, "_generate_json", side_effect=lambda *args, **kwargs: next(responses)):
            result = vision_server.classify_image_bytes(make_png(), request_id)
        self.assertFalse(result.get("ok"))
        self.assertEqual(result.get("error_code"), "invalid_or_missing_bbox")

    def test_product_empty_keywords_returns_explicit_error(self):
        request_id = "d3234567-1234-4234-8234-123456789abc"
        responses = iter([
            {"type": "product_screenshot", "confidence": 0.95, "bbox_2d": [100, 100, 500, 500]},
            {"keywords": []},
        ])
        with patch.object(vision_server, "_generate_json", side_effect=lambda *args, **kwargs: next(responses)):
            result = vision_server.classify_image_bytes(make_png(), request_id)
        self.assertFalse(result.get("ok"))
        self.assertEqual(result.get("error_code"), "no_keywords")

    def test_inverted_bbox_coordinates_are_normalized(self):
        box = vision_server._parse_bbox([500, 600, 100, 200], 1000, 1000)
        self.assertIsNotNone(box)
        # left should be based on min(100, 500) = 100, top on min(200, 600) = 200
        left, top, right, bottom = box
        self.assertLess(left, right)
        self.assertLess(top, bottom)
        self.assertLessEqual(left, 100)
        self.assertLessEqual(top, 200)
        self.assertGreaterEqual(right, 500)
        self.assertGreaterEqual(bottom, 600)

    def test_rescue_pass_upgrades_general_media_with_large_bbox_to_product(self):
        """When first pass says general_media but provides a large bbox (>=25% area),
        rescue pass crops the region, runs keyword extraction, and if non-person keywords
        are returned, classifies as product_screenshot in 2 total model calls."""
        request_id = "r1234567-1234-4234-8234-123456789abc"
        call_count = [0]

        def fake_generate(_image, instruction, _request_id, **_kwargs):
            call_count[0] += 1
            if call_count[0] == 1:
                # First pass: says general_media but gives a large bbox covering most of the image
                return {
                    "type": "general_media",
                    "confidence": 0.9,
                    "bbox_2d": [0, 0, 672, 868],  # large bbox ~100% of 640x480 img
                    "product_name": "",
                }
            else:
                # Rescue pass = keyword extraction on the cropped region
                return {"keywords": ["dildo", "silicone toy"]}

        with patch.object(vision_server, "_generate_json", side_effect=fake_generate):
            result = vision_server.classify_image_bytes(make_png(), request_id)

        self.assertEqual(call_count[0], 2)
        self.assertEqual(result["type"], "product_screenshot")
        self.assertEqual(result["keywords"], ["dildo", "silicone toy"])

    def test_rescue_pass_does_not_fire_for_small_bbox(self):
        """Rescue pass must NOT fire when bbox covers <25% of image (not a suspicious mislabel)."""
        request_id = "r2234567-1234-4234-8234-123456789abc"
        call_count = [0]

        def fake_generate(_image, instruction, _request_id, **_kwargs):
            call_count[0] += 1
            # Small bbox: [0,0,78,102] on 640x480 → ~0.8% pixel area, well below 25% threshold.
            return {
                "type": "general_media",
                "confidence": 0.95,
                "bbox_2d": [0, 0, 78, 102],
                "product_name": "",
            }

        with patch.object(vision_server, "_generate_json", side_effect=fake_generate):
            result = vision_server.classify_image_bytes(make_png(), request_id)

        self.assertEqual(call_count[0], 1)
        self.assertEqual(result["type"], "general_media")

    def test_rescue_pass_stays_general_media_when_keywords_are_person_only(self):
        """If rescue keyword extraction returns only person/body terms, result stays general_media."""
        request_id = "r3234567-1234-4234-8234-123456789abc"
        call_count = [0]

        def fake_generate(_image, instruction, _request_id, **_kwargs):
            call_count[0] += 1
            if call_count[0] == 1:
                return {"type": "general_media", "confidence": 0.9, "bbox_2d": [0, 0, 672, 868]}
            else:
                # Rescue pass returns only person terms → not a product
                return {"keywords": ["woman", "person", "face"]}

        with patch.object(vision_server, "_generate_json", side_effect=fake_generate):
            result = vision_server.classify_image_bytes(make_png(), request_id)

        self.assertEqual(call_count[0], 2)
        self.assertEqual(result["type"], "general_media")


if __name__ == "__main__":
    unittest.main()
