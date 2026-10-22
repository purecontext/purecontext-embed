# @purecontext/embed

One embedding model per machine. A small background service loads an ONNX text-embedding model once and serves vectors to every process that asks for them over a unix socket.

It exists because every process that embeds locally otherwise loads its own copy. A bge-large model takes about 2.6 GB per copy, and ten sessions that each run a memory server will hold ten copies. With this package, they share one.

Designed for MCP servers and other Node.js processes that embed with [fastembed](https://github.com/Anush008/fastembed-js). The vectors are the same as fastembed's in-process output, bit for bit, with padding turned off.

## Install

```bash
npm install @purecontext/embed
```

## Quick Start

```ts
import { embed } from '@purecontext/embed'

const [vector] = await embed('/path/to/bge-large-en-v1.5', ['what did we decide about backups?'])
// vector is a Float32Array
```

The model directory holds `model.onnx` and `tokenizer.json`. The path must be absolute. Every client that names the same directory shares one load, symlinks included.

Pass `priority: 'batch'` for bulk work such as an ingest or a re-embed:

```ts
const vectors = await embed(modelDir, chunks, { priority: 'batch' })
```

## The Service

`embed` starts the service when it is absent, detached so it keeps running after the caller exits. Then:

- **One inference at a time.** The model runs one text at a time, and every waiting interactive text goes before any batch text. A search arriving during a ten-thousand-chunk ingest waits for at most the one embedding already running.
- **No padding.** fastembed pads every input to 512 tokens by default, so a short query costs as much as a full chunk. The service turns padding off and embeds one text at a time, which gives the same vectors for far less work.
- **One service per home.** A lock decides between clients that start it at the same moment, and a lock left by a dead process is reclaimed.
- **Upgrades.** A client newer than the running service stops it and starts its own version. An older client uses a newer service.
- **Idle exit.** With no requests for 30 minutes, the service exits and frees the model's memory. The next call starts it again, which costs a few seconds while the model loads. Set `PURECONTEXT_EMBED_IDLE_MS` to change the wait.
- **Retries.** When the service exited between calls, or is stopping for an upgrade, the client starts a new one and retries once. Errors throw `EmbedServiceError`, whose `retryable` says whether trying again later could succeed.

There is no in-process fallback. A process that cannot reach the service fails its embed rather than loading a private copy, since a silent fallback would bring back one copy per process.

The service lives in `~/.config/purecontext/embed`, or in `PURECONTEXT_EMBED_HOME` when that is set. That folder holds the socket, the lock and the service log `serve.log`, and is created with mode 700.

### Command line

```bash
purecontext-embed status         # version, memory, queue and loaded models; exit 2 when not running
purecontext-embed status --json  # the same, for other tools
purecontext-embed stop
purecontext-embed serve          # run in the foreground
```

`serviceStatus()`, `ensureService()` and `stopService()` do the same from code.

### Protocol

HTTP over the unix socket, for clients in other languages:

- `POST /embed` takes `{"model": "<absolute dir>", "texts": ["..."], "priority": "interactive" | "batch"}` and returns `{"dims": 1024, "vectors": ["<base64>"]}`. Each vector is little-endian float32, base64-encoded.
- `GET /status` returns the version, pid, memory, queue depths, and each model's state, load time, last use and count.
- `POST /stop` stops the service. Requests still waiting get a 503, which means retry.

## Development

```bash
pnpm install
pnpm test   # builds, then runs every test; the real-model tests run when ~/.cairn/models/bge-large-en-v1.5 exists
pnpm lint
```

Set `PURECONTEXT_EMBED_TEST_MODEL` to point the real-model tests at another model directory.

## License

MIT
