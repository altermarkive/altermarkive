#!/usr/bin/env -S uv run --script
# -*- coding: utf-8 -*-
# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "cryptography",
#     "fastapi",
#     "uvicorn",
#     "websockets",
# ]
# ///
# Minimal FastAPI server exposing souffleur.html at the root path over HTTPS.
# Generates a self-signed certificate next to this script on first run, so the
# page's microphone capture works from other devices on the LAN (accept the
# browser warning once).

import datetime
import socket
import sys
from array import array
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse

HTML = Path(__file__).with_name("souffleur.html")
SCREENSHOT = Path(__file__).with_name("screenshot.jpg")
CERT = Path(__file__).with_name("serve.crt")
KEY = Path(__file__).with_name("serve.key")

app = FastAPI()


@app.get("/")
def root() -> FileResponse:
    return FileResponse(HTML)


@app.post("/screenshot")
async def screenshot(request: Request) -> dict[str, int]:
    image = await request.body()
    SCREENSHOT.write_bytes(image)
    return {"bytes": len(image)}


@app.websocket("/audio")
async def audio(websocket: WebSocket) -> None:
    await websocket.accept()
    try:
        while True:
            block = array("f", await websocket.receive_bytes())
            pcm = [int(max(-1.0, min(1.0, v)) * 0x7fff) for v in block]
            sys.stdout.write(f"\r{pcm[-1]:>6}")
            sys.stdout.flush()
    except WebSocketDisconnect:
        pass


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


if __name__ == "__main__":
    import uvicorn

    ensure_cert()
    uvicorn.run(app, host="0.0.0.0", port=8443, ssl_certfile=str(CERT), ssl_keyfile=str(KEY))
