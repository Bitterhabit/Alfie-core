#!/usr/bin/env python3
"""
Alfie Core — Optional Stateless Python Embedding & Reranking Worker (v1)

Architectural boundary (see docs/VISION.md):
- Strictly stateless compute service called internally by Node Core via
  ALFIE_EMBEDDING_WORKER_URL (e.g. http://127.0.0.1:8091).
- Never owns durable memory, permissions, tools, approvals, or user state.
- Uses sentence-transformers when installed, falling back to pure-stdlib
  TF-IDF + character trigram cosine similarity with zero external packages.
"""

from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import math
import os
import re
from collections import Counter

MODEL_NAME = os.environ.get("ALFIE_EMBEDDING_MODEL", "all-MiniLM-L6-v2")
HOST = os.environ.get("ALFIE_WORKER_HOST", "127.0.0.1")
PORT = int(os.environ.get("ALFIE_WORKER_PORT", "8091"))
MAX_BODY_BYTES = 512 * 1024

_ST_MODEL = None
try:
    from sentence_transformers import SentenceTransformer  # type: ignore

    _ST_MODEL = SentenceTransformer(MODEL_NAME)
except Exception:
    _ST_MODEL = None

TOKEN_RE = re.compile(r"[a-z0-9_-]+")


def _features(text: str) -> Counter:
    counts: Counter = Counter()
    for tok in TOKEN_RE.findall((text or "").lower()):
        counts[f"w:{tok}"] += 2.0
        if len(tok) >= 3:
            padded = f"^{tok}$"
            for i in range(len(padded) - 2):
                counts[f"g:{padded[i:i+3]}"] += 0.65
    return counts


def _cosine(a: Counter, b: Counter) -> float:
    if not a or not b:
        return 0.0
    dot = sum(val * b.get(key, 0.0) for key, val in a.items())
    norm_a = math.sqrt(sum(v * v for v in a.values()))
    norm_b = math.sqrt(sum(v * v for v in b.values()))
    if norm_a == 0.0 or norm_b == 0.0:
        return 0.0
    return dot / (norm_a * norm_b)


def score_documents(query: str, documents: list) -> list:
    if _ST_MODEL is not None and documents:
        texts = [str(d.get("text", ""))[:1200] for d in documents]
        embeddings = _ST_MODEL.encode([query] + texts, normalize_embeddings=True)
        q_vec = embeddings[0]
        results = []
        for idx, doc in enumerate(documents):
            d_vec = embeddings[idx + 1]
            sim = float(sum(float(a) * float(b) for a, b in zip(q_vec, d_vec)))
            results.append({"id": str(doc.get("id", "")), "score": round(sim, 4)})
        return results

    q_feat = _features(query)
    results = []
    for doc in documents:
        d_feat = _features(str(doc.get("text", ""))[:1200])
        results.append({"id": str(doc.get("id", "")), "score": round(_cosine(q_feat, d_feat), 4)})
    return results


class WorkerHandler(BaseHTTPRequestHandler):
    def _send_json(self, status: int, payload: dict) -> None:
        raw = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self) -> None:
        if self.path == "/health":
            self._send_json(
                200,
                {
                    "ok": True,
                    "service": "alfie-embedding-worker",
                    "engine": f"sentence-transformers:{MODEL_NAME}" if _ST_MODEL else "stdlib-trigram-cosine",
                },
            )
            return
        self._send_json(404, {"error": "Not found"})

    def do_POST(self) -> None:
        if self.path != "/rerank":
            self._send_json(404, {"error": "Not found"})
            return
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > MAX_BODY_BYTES:
            self._send_json(400, {"error": "Invalid request size"})
            return
        try:
            body = json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception:
            self._send_json(400, {"error": "Invalid JSON"})
            return
        query = str(body.get("query", "")).strip()[:300]
        documents = body.get("documents", [])
        if not isinstance(documents, list):
            self._send_json(400, {"error": "documents must be a list"})
            return
        scores = score_documents(query, documents[:80])
        self._send_json(200, {"scores": scores})

    def log_message(self, format: str, *args) -> None:  # noqa: A002
        return


if __name__ == "__main__":
    server = HTTPServer((HOST, PORT), WorkerHandler)
    print(f"Alfie stateless embedding worker listening on {HOST}:{PORT}")
    server.serve_forever()
