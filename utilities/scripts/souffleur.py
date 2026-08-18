#!/usr/bin/env -S uv run --script
# -*- coding: utf-8 -*-
# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "bm25s",
#     "cryptography",
#     "fastapi",
#     "langchain-anthropic",
#     "numpy",
#     "pytest",
#     "sentence-transformers",
#     "torch",
#     "transformers",
#     "typer",
#     "uvicorn",
#     "websockets",
# ]
# ///
# Serves souffleur.html over HTTPS and solves the assignment the page's audio and
# camera capture. Audio arrives as Float32 blocks over a WebSocket, is segmented by
# VAD and transcribed; a still posted to /screenshot is the visual context; the page's
# Solve button hits /solve/rag and /solve/llm separately, so the fast retrieval answer
# is not held up by the LLM round trip.

import asyncio
import base64
import dataclasses
import datetime
import logging
import os
import pathlib
import queue
import socket
import threading
import warnings

import bm25s
import numpy as np
import torch
import typer
import uvicorn
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from langchain_anthropic import ChatAnthropic
from langchain_core.messages import HumanMessage
from sentence_transformers import SentenceTransformer
from transformers import (
    WhisperForConditionalGeneration,
    WhisperProcessor,
    pipeline,
)
from transformers.utils import logging as transformers_logging


warnings.filterwarnings('ignore', message='A custom logits processor of type')
warnings.filterwarnings('ignore', message='You seem to be using the pipelines sequentially on GPU')
warnings.filterwarnings('ignore', message='You are sending unauthenticated requests')
transformers_logging.set_verbosity_error()
logging.getLogger('huggingface_hub').setLevel(logging.ERROR)


SAMPLE_RATE = 16000
SCREENSHOT_MEDIA_TYPE = 'image/jpeg'

TRANSCRIPT = pathlib.Path('transcript.txt')
SCREENSHOT = pathlib.Path('screenshot.jpg')
CERT = pathlib.Path('souffleur.crt')
KEY = pathlib.Path('souffleur.key')
HTML = pathlib.Path(__file__).with_name('souffleur.html')


WHISPER_HUGGINGFACE_ID = 'openai/whisper-large-v3'


class WhisperPipeline:
    def __init__(self, model_id: str, device: str, dtype: torch.dtype) -> None:
        asr_model = WhisperForConditionalGeneration.from_pretrained(
            model_id, torch_dtype=dtype, low_cpu_mem_usage=True, use_safetensors=True
        ).to(device)
        processor = WhisperProcessor.from_pretrained(model_id)
        self._pipe = pipeline(
            'automatic-speech-recognition',
            model=asr_model,
            tokenizer=processor.tokenizer,
            feature_extractor=processor.feature_extractor,
            dtype=dtype,
            device=device,
            batch_size=1,
        )
        self._pipe.model.generation_config.language = 'en'
        self._pipe.model.generation_config.task = 'transcribe'
        self._pipe.model.generation_config.no_repeat_ngram_size = 3
        self._pipe.model.generation_config.forced_decoder_ids = None

    def __call__(self, audio: np.ndarray) -> dict:
        return self._pipe(audio)


ANTHROPIC_BASE_URL = 'https://api.anthropic.com'
ANTHROPIC_API_KEY_ENV = 'ANTHROPIC_API_KEY'
DEFAULT_MODEL = 'claude-opus-5'
# Ceiling per response.
MAX_TOKENS = 4096
# The solver now spots the question and answers it in one request, so it carries
# the whole live path on its own. Adaptive thinking at low effort buys answer
# quality without the turnaround a higher effort would add.
SOLVE_EFFORT = 'low'
# Thinking tokens are drawn from the same budget as the answer, so the solver
# needs headroom the other roles do not - without it a long deliberation eats
# the budget and the answer is truncated mid-sentence.
SOLVE_MAX_TOKENS = 8192
# One transcript line is one VAD segment. With --min-silence-ms=600 a segment ends
# at the first pause past 600 ms and is capped at --max-speech-ms=15000, so lines
# run 0.3-15 s with conversational speech landing around 3-5 s. 15 lines is the
# middle of that: roughly a minute of speech, a couple of minutes of slow Q&A.
RAG_TRANSCRIPT_LINES = 15


@dataclasses.dataclass
class Chunk:
    title: str
    content: str


@dataclasses.dataclass
class Answer:
    label: str    # solver that produced this, plus its score where it has one
    query: str    # what the solver keyed on, shown as the header; blank to omit
    text: str


def load_chunks(paths: list[str]) -> list[Chunk]:
    chunks: list[Chunk] = []
    for path in paths:
        text = pathlib.Path(path).read_text()
        for raw in text.split('\n---\n'):
            lines = raw.strip().splitlines()
            title_idx = next((i for i, l in enumerate(lines) if l.startswith('## ')), None)
            if title_idx is None:
                continue
            title = lines[title_idx][2:].strip()
            content = '\n'.join(lines[:title_idx] + lines[title_idx + 1:]).strip()
            if title and content:
                chunks.append(Chunk(title, content))
            elif title_idx is not None:
                print(f'Warning: skipping chunk with title "{lines[title_idx]}" in {path} (empty content)')
    return chunks


class DenseIndex:
    def __init__(self, model_id: str, chunks: list[Chunk]) -> None:
        self.model = SentenceTransformer(model_id)
        self.embeddings = self.model.encode(
            [chunk.title for chunk in chunks], normalize_embeddings=True, convert_to_numpy=True,
        )

    def scores(self, query: str) -> np.ndarray:
        query_embedding = self.model.encode(
            [query], prompt_name='query', normalize_embeddings=True, convert_to_numpy=True,
        )
        # Cosine similarity per chunk (vectors are unit-normalized)
        return self.embeddings @ query_embedding[0]

    def rank(self, query: str) -> np.ndarray:
        return np.argsort(-self.scores(query))


class BM25Index:
    def __init__(self, chunks: list[Chunk]) -> None:
        self.tokenizer = bm25s.tokenization.Tokenizer(lower=True, stopwords=None)
        corpus_tokens = self.tokenizer.tokenize([c.title for c in chunks], return_as="tuple")
        self.retriever = bm25s.BM25()
        self.retriever.index(corpus_tokens)

    def rank(self, query: str) -> np.ndarray:
        query_tokens = self.tokenizer.tokenize([query], return_as="string", update_vocab=False)[0]
        scores = self.retriever.get_scores(query_tokens)
        return np.argsort(-scores)


def reciprocal_rank_fusion(rank_lists: list[np.ndarray], k: int = 60) -> np.ndarray:
    n = len(rank_lists[0])
    scores = np.zeros(n)
    for ranks in rank_lists:
        for r, idx in enumerate(ranks):
            scores[idx] += 1.0 / (k + r)
    return np.argsort(-scores)


class Retriever:
    def __init__(self, chunks: list[Chunk], embed_model: str) -> None:
        self.chunks = chunks
        self.dense = DenseIndex(embed_model, chunks)
        self.bm25 = BM25Index(chunks)

    def _retrieve(self, query: str) -> tuple[np.ndarray, np.ndarray]:
        dense_scores = self.dense.scores(query)
        fused = reciprocal_rank_fusion([np.argsort(-dense_scores), self.bm25.rank(query)])
        return dense_scores, fused

    def top1_with_confidence_without_margin(
        self, query: str, min_score: float
    ) -> tuple[Chunk, bool, float]:
        dense_scores, fused = self._retrieve(query)
        top_score = float(dense_scores[fused[0]])
        return self.chunks[fused[0]], top_score >= min_score, top_score


@dataclasses.dataclass
class SessionState:
    transcript: str = ''
    screenshot: str = ''
    solution: str = ''
    lock: threading.Lock = dataclasses.field(
        default_factory=threading.Lock, init=False, repr=False, compare=False
    )

    def add_transcript(self, text: str) -> None:
        with self.lock:
            self.transcript += text + '\n'
            with open(TRANSCRIPT, 'w') as handle:
                handle.write(self.transcript)

    def update_screenshot(self, screenshot: str) -> None:
        with self.lock:
            self.screenshot = screenshot

    def update_solution(self, text: str) -> None:
        with self.lock:
            self.solution = text

    def snapshot(self) -> tuple[str, str]:
        with self.lock:
            return self.transcript, self.screenshot


"""
Energy-envelope Voice Activity Detection (VAD).

Note: A frame is a small fixed-size slice of audio samples - the unit the VAD processes
one at a time rather than all at once.
At 16 kHz, 20 ms = 320 samples. Each call to vad.feed() receives exactly that array.
We are using 20 ms as a default because it is a standard in speech processing because
it matches the typical time scale of a phoneme - short enough that speech/silence transitions
are detected quickly, but long enough that the RMS energy measurement is stable
and not fooled by individual waveform peaks.
At 10 ms you get noisier energy estimates; at 40 ms you start missing fast transitions.

For noisier environments (music, HVAC, keyboard) the RMS threshold false-triggers and
sends non-speech segments to the ASR model. A drop-in replacement using `silero-vad`
(~1.8 MB JIT model, sub-ms inference per 32 ms frame) keeps the same feed/flush
contract (would need to fix the window to 512 samples (Silero's 16 kHz requirement) and replace
the RMS check with model inference).
"""
class VadAccumulator:
    def __init__(
        self,
        frame_ms: int = 20,
        energy_threshold: float = 0.01,
        min_silence_ms: int = 800,
        min_speech_ms: int = 300,
        max_speech_ms: int = 15000,
    ) -> None:
        self.frame_samples = SAMPLE_RATE * frame_ms // 1000
        self._min_silence_frames = min_silence_ms // frame_ms
        self._min_speech_frames = min_speech_ms // frame_ms
        self._max_speech_samples = int(max_speech_ms / 1000 * SAMPLE_RATE)
        self._energy_threshold = energy_threshold
        self._buffer: list[np.ndarray] = []
        self._speech_frames = 0
        self._silence_frames = 0
        self._in_speech = False

    def feed(self, frame: np.ndarray) -> np.ndarray | None:
        is_speech = np.sqrt(np.mean(frame ** 2)) >= self._energy_threshold
        if is_speech:
            self._buffer.append(frame)
            self._speech_frames += 1
            self._silence_frames = 0
            self._in_speech = True
            if sum(len(frame) for frame in self._buffer) >= self._max_speech_samples:
                return self.flush()
        elif self._in_speech:
            self._buffer.append(frame)
            self._silence_frames += 1
            if self._silence_frames >= self._min_silence_frames:
                return self.flush()
        return None

    def flush(self) -> np.ndarray | None:
        segment: np.ndarray | None = None
        if self._speech_frames >= self._min_speech_frames:
            segment = np.concatenate(self._buffer)
        # Reset buffer
        self._buffer = []
        self._speech_frames = 0
        self._silence_frames = 0
        self._in_speech = False
        return segment


def transcribe_worker(
    pipe: pipeline,
    audio: queue.Queue[np.ndarray | None],
    state: SessionState,
) -> None:
    while True:
        segment = audio.get()
        if segment is None:
            break
        text = pipe(segment)['text'].strip()
        if text:
            state.add_transcript(text)


PROMPT_SOLUTION = """
You are monitoring a live transcript and screen capture for someone who is being examined.
Identify the most recent question or task, then answer it - in one step.

Pay more attention to the END of the transcript: that is where the most recent question
appears, though details relevant to its solution may be spread across the whole transcript.

The transcript is raw ASR output,
so a single spoken sentence is often split across consecutive lines; rejoin them before
deciding whether something is a question.

A screen capture is attached when one is available. Treat it as context for the same
question: it may hold the task text, given values, or a partial solution.

<transcript>
{transcript}
</transcript>

Respond in exactly this shape, with no preamble and no XML tags:

QUESTION: <the question on a single line, original wording, no source tags>

TL;DR: <one or two sentences summarising the answer>

<detailed answer using bullet points - correct and complete, but no padding or repetition;
prefer bullet points over a block of text>
"""


def split_question(text: str) -> tuple[str, str]:
    lines = text.splitlines()
    for index, line in enumerate(lines):
        if line.startswith('QUESTION:'):
            return line[len('QUESTION:'):].strip(), '\n'.join(lines[index + 1:]).strip()
    return '', text


def solve_llm(state: SessionState, client: ChatAnthropic) -> Answer:
    transcript, screenshot = state.snapshot()
    content = []
    if screenshot:
        content.append({
            'type': 'image_url',
            'image_url': {'url': f'data:{SCREENSHOT_MEDIA_TYPE};base64,{screenshot}'},
        })
    content.append({'type': 'text', 'text': PROMPT_SOLUTION.format(
        transcript=transcript or '(empty)',
    )})
    response = client.invoke([HumanMessage(content=content)])
    question, answer = split_question(response.content.strip())
    state.update_solution(answer)
    return Answer('LLM', question, answer)


def solve_rag(
    state: SessionState,
    retriever: Retriever,
    min_score: float,
    transcript_lines: int,
) -> Answer | None:
    transcript, _ = state.snapshot()
    if not transcript:
        return None
    query = '\n'.join(transcript.splitlines()[-transcript_lines:])
    chunk, confident, top_score = retriever.top1_with_confidence_without_margin(query, min_score)
    if not confident:
        return None
    return Answer(f'RAG score {top_score:.3f}', '', chunk.content)


@dataclasses.dataclass
class Runtime:
    state: SessionState
    audio: queue.Queue[np.ndarray | None]
    client: ChatAnthropic
    retriever: Retriever | None
    min_silence_ms: int
    max_speech_ms: int
    rag_min_score: float
    rag_transcript_lines: int


runtime: Runtime = None  # type: ignore[assignment]

app = FastAPI()


@app.get('/')
def root() -> FileResponse:
    return FileResponse(HTML)


@app.websocket('/audio')
async def audio_socket(websocket: WebSocket) -> None:
    await websocket.accept()
    vad = VadAccumulator(
        min_silence_ms=runtime.min_silence_ms, max_speech_ms=runtime.max_speech_ms
    )
    residue = np.empty(0, dtype=np.float32)
    try:
        while True:
            block = np.frombuffer(await websocket.receive_bytes(), dtype=np.float32)
            residue = np.concatenate([residue, block])
            while len(residue) >= vad.frame_samples:
                frame, residue = residue[:vad.frame_samples], residue[vad.frame_samples:]
                segment = vad.feed(frame)
                if segment is not None:
                    runtime.audio.put(segment)
    except WebSocketDisconnect:
        segment = vad.flush()
        if segment is not None:
            runtime.audio.put(segment)


@app.post('/screenshot')
async def screenshot(request: Request) -> dict[str, int]:
    image = await request.body()
    SCREENSHOT.write_bytes(image)
    runtime.state.update_screenshot(base64.b64encode(image).decode())
    return {'bytes': len(image)}


@app.post('/solve/rag')
async def rag() -> dict[str, dict[str, str] | None]:
    if runtime.retriever is None:
        return {'answer': None}
    answer = await asyncio.to_thread(
        solve_rag,
        runtime.state,
        runtime.retriever,
        runtime.rag_min_score,
        runtime.rag_transcript_lines,
    )
    return {'answer': dataclasses.asdict(answer) if answer is not None else None}


@app.post('/solve/llm')
async def llm() -> dict[str, dict[str, str]]:
    """The slow half: blocking, so it runs on a worker thread."""
    answer = await asyncio.to_thread(solve_llm, runtime.state, runtime.client)
    return {'answer': dataclasses.asdict(answer)}


def ensure_cert() -> None:
    if CERT.exists() and KEY.exists():
        return
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, socket.gethostname())])
    now = datetime.datetime.now(datetime.UTC)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=365))
        .sign(key, hashes.SHA256())
    )
    CERT.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    KEY.write_bytes(
        key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )
    KEY.chmod(0o600)


def make_client(model: str, effort: str | None = None, max_tokens: int = MAX_TOKENS) -> ChatAnthropic:
    """Adaptive thinking at `effort` when one is given, thinking off otherwise."""
    api_key = os.environ.get(ANTHROPIC_API_KEY_ENV)
    if not api_key:
        raise RuntimeError(f'{ANTHROPIC_API_KEY_ENV} is not set.')
    extra = {}
    if effort is None:
        thinking = {'type': 'disabled'}
    else:
        thinking = {'type': 'adaptive'}
        extra['output_config'] = {'effort': effort}
    return ChatAnthropic(
        base_url=ANTHROPIC_BASE_URL,
        api_key=api_key,
        model=model,
        max_tokens=max_tokens,
        thinking=thinking,
        **extra,
    )


def main(
    port: int = typer.Option(
        8443,
        '--port',
        help='HTTPS port the page and its endpoints are served on.',
    ),
    min_silence_ms: int = typer.Option(
        600,
        '--min-silence-ms',
        help='Milliseconds of silence required to end a speech segment.',
    ),
    max_speech_ms: int = typer.Option(
        15000,
        '--max-speech-ms',
        help='Maximum milliseconds of speech before forcing a speech segment boundary.',
    ),
    solve_model: str = typer.Option(
        DEFAULT_MODEL,
        '--solve-model',
        help='Anthropic model used to spot the current question and answer it. Set ANTHROPIC_API_KEY.',
    ),
    solve_content: list[str] = typer.Option(
        [],
        '--solve-content',
        help='Paths to text files used as the RAG corpus. The RAG lookup runs alongside the LLM lookup whenever these are given, and is skipped otherwise. Each file is chunked on "---" lines; each chunk needs a "## Title" line as its retrieval key.',
    ),
    embed_model: str = typer.Option(
        'Qwen/Qwen3-Embedding-0.6B',
        '--embed-model',
        help='SentenceTransformer model for RAG embeddings. Default is Qwen/Qwen3-Embedding-0.6B (best quality <1B). CPU-friendly alternative: google/embeddinggemma-300m-qat-q8.',
    ),
    rag_min_score: float = typer.Option(
        0.5,
        '--rag-min-score',
        help='Minimum dense cosine similarity for the RAG top match to be considered confident. Below this threshold, only the LLM answer is returned.',
    ),
    rag_transcript_lines: int = typer.Option(
        RAG_TRANSCRIPT_LINES,
        '--rag-transcript-lines',
        help='Number of trailing transcript lines (VAD segments) used as the RAG query. One line is one speech segment, so the default of 15 covers roughly a minute of speech.',
    ),
) -> None:
    global runtime

    if not os.environ.get(ANTHROPIC_API_KEY_ENV):
        raise RuntimeError(f'{ANTHROPIC_API_KEY_ENV} is not set.')

    print('Loading model...')
    device = 'cuda:0' if torch.cuda.is_available() else 'cpu'
    dtype = torch.float16 if torch.cuda.is_available() else torch.float32
    pipe = WhisperPipeline(WHISPER_HUGGINGFACE_ID, device, dtype)

    retriever: Retriever | None = None
    if solve_content:
        print('Loading embedder and indexing corpus...')
        chunks = load_chunks(solve_content)
        if chunks:
            retriever = Retriever(chunks, embed_model)
            print(f'Indexed {len(chunks)} chunks.')
        else:
            print('No valid chunks found in --solve-content files, running the LLM lookup only.')

    # TODO: Move the session state client-side, this will allow to have a queue per session
    audio: queue.Queue[np.ndarray | None] = queue.Queue()
    state = SessionState()
    runtime = Runtime(
        state=state,
        audio=audio,
        client=make_client(solve_model, effort=SOLVE_EFFORT, max_tokens=SOLVE_MAX_TOKENS),
        retriever=retriever,
        min_silence_ms=min_silence_ms,
        max_speech_ms=max_speech_ms,
        rag_min_score=rag_min_score,
        rag_transcript_lines=rag_transcript_lines,
    )

    threading.Thread(target=transcribe_worker, args=(pipe, audio, state), daemon=True).start()

    ensure_cert()
    try:
        uvicorn.run(app, host='0.0.0.0', port=port, ssl_certfile=str(CERT), ssl_keyfile=str(KEY))
    finally:
        audio.put(None)


if __name__ == '__main__':
    typer.run(main)


# Tests - run with: uv run --with pytest --with numpy --with soundfile --with torch --with torchvision --with transformers --with typer --with accelerate --with librosa --with pillow --with mistral-common python -m pytest utilities/scripts/live.py -v
class TestVadAccumulator:
    _FRAME_SAMPLES = SAMPLE_RATE * 20 // 1000  # 320 samples per 20ms frame

    @staticmethod
    def _make_speech_frame(energy: float = 0.05) -> np.ndarray:
        t = np.linspace(0, 20 / 1000, TestVadAccumulator._FRAME_SAMPLES, endpoint=False)
        return (energy * np.sin(2 * np.pi * 440 * t)).astype(np.float32)

    @staticmethod
    def _make_silent_frame() -> np.ndarray:
        return np.zeros(TestVadAccumulator._FRAME_SAMPLES, dtype=np.float32)

    def test_silence_only_emits_nothing(self):
        vad = VadAccumulator()
        for _ in range(200):
            assert vad.feed(TestVadAccumulator._make_silent_frame()) is None
        assert vad.flush() is None

    def test_speech_then_silence_emits_segment(self):
        vad = VadAccumulator(min_silence_ms=600, min_speech_ms=300)
        for _ in range(25):  # 500ms speech
            result = vad.feed(TestVadAccumulator._make_speech_frame())
            assert result is None
        segment = None
        for _ in range(35):  # 700ms silence
            result = vad.feed(TestVadAccumulator._make_silent_frame())
            if result is not None:
                segment = result
                break
        assert segment is not None
        assert len(segment) >= 25 * TestVadAccumulator._FRAME_SAMPLES

    def test_short_speech_below_min_is_discarded(self):
        vad = VadAccumulator(min_silence_ms=200, min_speech_ms=500)
        for _ in range(5):  # 100ms speech
            vad.feed(TestVadAccumulator._make_speech_frame())
        for _ in range(50):
            result = vad.feed(TestVadAccumulator._make_silent_frame())
            assert result is None

    def test_brief_silence_does_not_split(self):
        vad = VadAccumulator(min_silence_ms=600, min_speech_ms=300)
        for _ in range(25):
            vad.feed(TestVadAccumulator._make_speech_frame())
        for _ in range(10):  # 200ms silence
            assert vad.feed(TestVadAccumulator._make_silent_frame()) is None
        for _ in range(25):
            assert vad.feed(TestVadAccumulator._make_speech_frame()) is None
        segment = None
        for _ in range(35):
            result = vad.feed(TestVadAccumulator._make_silent_frame())
            if result is not None:
                segment = result
                break
        assert segment is not None
        assert len(segment) >= 50 * TestVadAccumulator._FRAME_SAMPLES

    def test_max_speech_cap_forces_emit(self):
        vad = VadAccumulator(max_speech_ms=1000)
        segment = None
        for _ in range(75):  # 1.5s continuous speech
            result = vad.feed(TestVadAccumulator._make_speech_frame())
            if result is not None:
                segment = result
                break
        assert segment is not None
        expected = int(1.0 * SAMPLE_RATE)
        assert abs(len(segment) - expected) < TestVadAccumulator._FRAME_SAMPLES * 2

    def test_flush_returns_accumulated_speech(self):
        vad = VadAccumulator(min_speech_ms=300)
        for _ in range(25):
            vad.feed(TestVadAccumulator._make_speech_frame())
        segment = vad.flush()
        assert segment is not None
        assert len(segment) == 25 * TestVadAccumulator._FRAME_SAMPLES

    def test_flush_on_empty_returns_none(self):
        vad = VadAccumulator()
        assert vad.flush() is None


# The solver hits the Anthropic API - export ANTHROPIC_API_KEY first.
# Frequently used: uv run utilities/scripts/souffleur.py
# RAG alongside the LLM: uv run utilities/scripts/souffleur.py --solve-content something1.md --solve-content something2.md
# Cheaper solving: uv run utilities/scripts/souffleur.py --solve-model claude-sonnet-5
