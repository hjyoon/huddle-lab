"""Local-only Whisper transcription. Model files stay in the requested cache."""
import argparse
import json
import os

os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
from faster_whisper import WhisperModel

parser = argparse.ArgumentParser()
parser.add_argument("--cache", required=True)
parser.add_argument("--model", default="base")
parser.add_argument("--audio")
parser.add_argument("--check", action="store_true")
parser.add_argument("--language", default="ko")
args = parser.parse_args()
model = WhisperModel(args.model, device="cpu", compute_type="int8", cpu_threads=4,
                     download_root=args.cache, use_auth_token=False, local_files_only=args.check)
if args.audio:
    segments, info = model.transcribe(args.audio, language=None if args.language == "auto" else args.language,
                                      beam_size=1, condition_on_previous_text=False, vad_filter=False)
    text = "".join(segment.text for segment in segments).strip()
    print(json.dumps({"text": text, "language": info.language}, ensure_ascii=False), flush=True)
else:
    print(json.dumps({"ready": True, "model": args.model}), flush=True)
