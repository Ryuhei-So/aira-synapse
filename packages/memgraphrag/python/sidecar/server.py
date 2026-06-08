#!/usr/bin/env python3
"""MemGraphRAG Python NLP sidecar speaking JSON-RPC over stdio."""

from __future__ import annotations

import json
import re
import sys
from typing import Any, Dict, List, Tuple

import spacy

MODEL_NAMES = {
    "en": "en_core_sci_lg",
    "ja": "ja_ginza_electra",
}

_loaded_models: Dict[str, Any] = {}


def get_nlp(language: str):
    if language in _loaded_models:
        return _loaded_models[language]

    model_name = MODEL_NAMES[language]
    try:
        nlp = spacy.load(model_name)
    except Exception:
        blank_lang = "ja" if language == "ja" else "en"
        nlp = spacy.blank(blank_lang)
        if "sentencizer" not in nlp.pipe_names:
            nlp.add_pipe("sentencizer")
    _loaded_models[language] = nlp
    return nlp


def detect_language(text: str) -> str:
    if re.search(r"[\u3040-\u30ff\u4e00-\u9fff]", text):
        return "ja"
    return "en"


def split_sentences(text: str) -> List[Tuple[str, int]]:
    results: List[Tuple[str, int]] = []
    start = 0
    for match in re.finditer(r".*?(?:[。.!?]|$)", text, re.DOTALL):
        sentence = match.group(0)
        if not sentence:
            continue
        stripped = sentence.strip()
        if stripped:
            offset = text.find(stripped, start)
            results.append((stripped, offset if offset >= 0 else start))
            start = offset + len(stripped) if offset >= 0 else start + len(stripped)
    return results or [(text, 0)]


def extract_for_language(text: str, language: str, offset: int = 0) -> Dict[str, Any]:
    doc = get_nlp(language)(text)
    entities = []
    noun_phrases: List[str] = []

    for ent in getattr(doc, "ents", []):
        entities.append(
            {
                "text": ent.text,
                "label": ent.label_,
                "start": offset + ent.start_char,
                "end": offset + ent.end_char,
            }
        )

    if hasattr(doc, "noun_chunks"):
        try:
            noun_phrases.extend(chunk.text for chunk in doc.noun_chunks)
        except Exception:
            pass

    if not noun_phrases:
        tokens = []
        for token in doc:
            pos = getattr(token, "pos_", "")
            if pos in {"NOUN", "PROPN"} or (not pos and not token.is_punct):
                tokens.append(token.text)
            elif tokens:
                noun_phrases.append(" ".join(tokens).strip())
                tokens = []
        if tokens:
            noun_phrases.append(" ".join(tokens).strip())

    return {
        "entities": entities,
        "nounPhrases": [phrase for phrase in dict.fromkeys(noun_phrases) if phrase],
    }


def extract(text: str, language: str) -> Dict[str, Any]:
    if language == "mixed":
        entities: List[Dict[str, Any]] = []
        noun_phrases: List[str] = []
        for sentence, offset in split_sentences(text):
            routed = extract_for_language(sentence, detect_language(sentence), offset)
            entities.extend(routed["entities"])
            noun_phrases.extend(routed["nounPhrases"])
        return {
            "entities": entities,
            "nounPhrases": [phrase for phrase in dict.fromkeys(noun_phrases) if phrase],
        }

    return extract_for_language(text, language)


def success_response(request_id: Any, result: Dict[str, Any]) -> Dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def error_response(request_id: Any, code: int, message: str) -> Dict[str, Any]:
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "error": {"code": code, "message": message},
    }


def handle_request(payload: Dict[str, Any]) -> Dict[str, Any]:
    request_id = payload.get("id")
    method = payload.get("method")
    params = payload.get("params") or {}

    try:
        if method == "health":
            return success_response(request_id, {"ok": True})
        if method == "extract":
            text = str(params.get("text", ""))
            language = str(params.get("language", "en"))
            return success_response(request_id, extract(text, language))
        return error_response(request_id, -32601, f"Method not found: {method}")
    except Exception as exc:  # pragma: no cover
        return error_response(request_id, -32000, str(exc))


def main() -> int:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            payload = json.loads(line)
        except json.JSONDecodeError as exc:
            response = error_response(None, -32700, f"Parse error: {exc}")
        else:
            response = handle_request(payload)
        sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
