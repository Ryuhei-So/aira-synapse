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

# Ordered fallback list for Japanese
JA_MODEL_FALLBACKS = ["ja_ginza_electra", "ja_ginza", "ja_core_news_lg", "ja_core_news_sm"]

_loaded_models: Dict[str, Any] = {}


def get_nlp(language: str):
    if language in _loaded_models:
        return _loaded_models[language]

    if language == "ja":
        # Try each JA model in order
        for model_name in JA_MODEL_FALLBACKS:
            try:
                nlp = spacy.load(model_name)
                _loaded_models[language] = nlp
                return nlp
            except Exception:
                continue
        # Final fallback: blank JA with sentencizer
        nlp = spacy.blank("ja")
        if "sentencizer" not in nlp.pipe_names:
            nlp.add_pipe("sentencizer")
        _loaded_models[language] = nlp
        return nlp

    model_name = MODEL_NAMES.get(language, f"{language}_core_web_sm")
    try:
        nlp = spacy.load(model_name)
    except Exception:
        nlp = spacy.blank(language)
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


def chunk_sentences_ja(text: str, max_tokens: int = 500) -> List[Dict[str, Any]]:
    """Split Japanese text into sentence-aware chunks using GINZA.

    Groups GINZA-detected sentences into chunks that don't exceed max_tokens.
    Token count is estimated as len(text) * 0.5 (consistent with JapaneseLanguageStrategy).
    """
    nlp = get_nlp("ja")
    doc = nlp(text)
    sentences = list(doc.sents)

    chunks: List[Dict[str, Any]] = []
    current_sents: List[str] = []
    current_tokens = 0

    for sent in sentences:
        sent_text = sent.text.strip()
        if not sent_text:
            continue
        sent_tokens = int(len(sent_text) * 0.5)

        if current_tokens + sent_tokens > max_tokens and current_sents:
            chunk_text = "".join(current_sents)
            chunks.append({
                "text": chunk_text,
                "sentenceCount": len(current_sents),
                "estimatedTokens": current_tokens,
            })
            # Overlap: keep last sentence for context continuity
            overlap_sent = current_sents[-1]
            current_sents = [overlap_sent]
            current_tokens = int(len(overlap_sent) * 0.5)

        current_sents.append(sent_text)
        current_tokens += sent_tokens

    if current_sents:
        chunk_text = "".join(current_sents)
        chunks.append({
            "text": chunk_text,
            "sentenceCount": len(current_sents),
            "estimatedTokens": current_tokens,
        })

    return chunks


def extract_entities_ja(text: str) -> Dict[str, Any]:
    """Extract NER entities and noun phrases from Japanese text using GINZA."""
    nlp = get_nlp("ja")
    doc = nlp(text)

    entities = []
    for ent in doc.ents:
        entities.append({
            "text": ent.text,
            "label": ent.label_,
            "start": ent.start_char,
            "end": ent.end_char,
        })

    # Extract noun phrases
    noun_phrases: List[str] = []
    try:
        import ginza
        for span in ginza.bunsetu_spans(doc):
            if span.root.pos_ in ("NOUN", "PROPN"):
                noun_phrases.append(span.text)
    except (ImportError, AttributeError, Exception):
        # Fallback: use noun_chunks or token-based extraction
        try:
            for chunk in doc.noun_chunks:
                noun_phrases.append(chunk.text)
        except Exception:
            # Token-based fallback for blank models
            current_phrase: List[str] = []
            for token in doc:
                if token.pos_ in ("NOUN", "PROPN"):
                    current_phrase.append(token.text)
                elif current_phrase:
                    noun_phrases.append("".join(current_phrase))
                    current_phrase = []
            if current_phrase:
                noun_phrases.append("".join(current_phrase))

    return {
        "entities": entities,
        "nounPhrases": list(dict.fromkeys(noun_phrases)),
    }


def tokenize_ja(text: str) -> Dict[str, Any]:
    """Tokenize Japanese text using GINZA for BM25 search."""
    nlp = get_nlp("ja")
    if nlp is None:
        # Fallback: character bigrams
        chars = text.strip()
        tokens = [chars[i:i+2] for i in range(len(chars)-1)]
        return {"tokens": tokens, "method": "bigram_fallback"}

    doc = nlp(text)
    tokens = []
    for token in doc:
        # Skip punctuation, symbols, spaces
        if token.pos_ in ("PUNCT", "SYM", "SPACE", "X"):
            continue
        # Use lemma for content words
        lemma = token.lemma_.strip()
        if len(lemma) >= 1:
            tokens.append(lemma)
    return {"tokens": tokens, "method": "ginza"}


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
        if method == "chunk_sentences":
            text = str(params.get("text", ""))
            max_tokens = int(params.get("maxTokens", 500))
            return success_response(request_id, {"chunks": chunk_sentences_ja(text, max_tokens)})
        if method == "extract_entities_ja":
            text = str(params.get("text", ""))
            return success_response(request_id, extract_entities_ja(text))
        if method == "tokenize_ja":
            text = str(params.get("text", ""))
            return success_response(request_id, tokenize_ja(text))
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
