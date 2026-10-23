# Atmosphere Dashboard

A self-hosted dashboard for an AT Protocol account. It replays repository events from a Jetstream service, caches repository state locally, and updates the dashboard as new events arrive.

## Run locally

Requires Node.js 22.23.4 or newer.

```sh
npm install
cp .env.example .env
```

Edit `.env` and set `TARGET_HANDLE` to the AT Protocol handle you want to follow. Set `JETSTREAM_API_KEY` to a valid archive-access key for the public Jetstream service, then start the app:

```sh
npm run dev
```

Open <http://localhost:3000>. The app resolves the handle and replays the configured Jetstream archive before connecting to its live tail. `data/at-me.db` is a disposable cache, not the source of truth. Keeping it speeds up restarts; deleting it while the app is stopped starts a replay from zero. Archive compaction can remove superseded operations, so a rebuild restores retained Jetstream data, not an exhaustive audit history.
When the public Bluesky profile includes an avatar, the dashboard shows it beside the display name and handle.
The header's Theme picker changes the dashboard colors and remembers the selection in this browser. Available palettes include Terminal Green, Tokyo Night, JetBrains Darcula, Nord, Gruvbox Dark, Solarized Dark, One Dark, Rosé Pine Moon, Cyberdream, Synthwave '84, Fruit Static, Radioactive Lagoon, and Clown Nebula.
Theme text and accents maintain at least 5:1 contrast across their surfaces; component borders maintain at least 3.5:1.
Fruit Static, Radioactive Lagoon, and Clown Nebula are original high-saturation palettes.
JetBrains Darcula is an independent, accessibility-adjusted palette adaptation; it is not an official JetBrains theme or endorsement. Palette references: [JetBrains Darcula](https://github.com/codemirror/codemirror5/blob/master/theme/darcula.css), [Rosé Pine Moon](https://github.com/rose-pine/windows-terminal/blob/main/rose-pine-moon.scheme.json), [Cyberdream](https://github.com/scottmckendry/cyberdream.nvim/blob/main/lua/cyberdream/colors.lua), and [Synthwave '84](https://github.com/robb0wen/synthwave-vscode/blob/master/themes/synthwave-color-theme.json).

The favicon remains the original monochrome `@` badge that adapts to light and dark browser themes. The SVG Open Graph card mirrors the dashboard’s real sections and loading state without invented chart data. Social metadata points to `https://at.michaelblack.xyz/opengraph.svg`.

## Run with Docker

Set `TARGET_HANDLE` and the service's `JETSTREAM_API_KEY` in `.env`, then build and run:

```sh
docker build -t at-me .
docker run --rm --env-file .env -p 3000:3000 at-me
```

The app runs as the unprivileged `node` user. Its data stays in the container and is lost when the container is removed; the next run starts a fresh backfill.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `TARGET_HANDLE` | Set this in `.env` | AT Protocol handle to follow. The example value is a placeholder. |
| `PORT` | `3000` | HTTP listen port. |
| `JETSTREAM_SERVICE` | `https://jetstream.us-east.bsky.network` | Jetstream endpoint. |
| `JETSTREAM_API_KEY` | *(empty)* | API key for archive planning/downloads and live access. Required by the public archive service; blank sends no authorization. |

## Recovery and live updates

The ingester uses Jetstream's replay cutover, including its global archive tip, rather than starting live consumption at the last event for an inactive account. If the service returns `FutureCursor` after an upstream sequence reset, the app closes that stream, clears the old cache (records, events, cursor, and deduplication state), and replays from zero automatically. It never merges events from incompatible sequence spaces.

The browser loads its first snapshot and subsequent updates over `/api/events`; there is no competing bootstrap fetch. Retry Connection closes and replaces the browser stream. SSE comments keep idle connections alive, and SIGTERM/SIGINT stop ingestion before flushing the cache and closing HTTP connections.

### Deploy the repair

After publishing an image containing this change, run these commands from the production HomePi checkout's `at-me` directory (the directory containing its Compose file):

```sh
docker compose pull at-me &&
docker compose up -d at-me
```

The existing future-cursor condition will trigger automatic cache rebuilding. To deliberately force a fresh replay instead, the following stops the sole writer and deletes **only** `/app/data/at-me.db` and its temporary file from the service's mounted volume:

```sh
docker compose pull at-me &&
docker compose stop at-me &&
docker compose run --rm --no-deps --entrypoint node at-me --input-type=module -e \
  'import { rmSync } from "node:fs"; for (const file of ["/app/data/at-me.db", "/app/data/at-me.db.tmp"]) rmSync(file, { force: true });' &&
docker compose up -d at-me
```

This discards cached history, including operations no longer retained by Jetstream. It leaves the named volume and unrelated files intact. Do not use `docker compose down -v` or delete the whole volume.

For a non-Docker instance, stop the app, delete `data/at-me.db` and `data/at-me.db.tmp`, and restart it with the same configuration.

### Verify recovery

```sh
curl --fail-with-body http://127.0.0.1:3002/health
docker compose logs --tail=100 at-me
```

`/health` returns HTTP 503 during reconstruction, retries, or disconnection, and HTTP 200 with `ok: true` only after a live WebSocket connection is established. The response includes `cursor`, `lastEventAt`, `lastConnectedAt`, `lastError`, and `lastAdvisory`. A remembered `FutureCursor` advisory can remain after successful rebuilding; check the current status and error too. An inactive account need not produce new events, so event age alone does not determine health.

Inspect `https://at.michaelblack.xyz/api/bootstrap` for `snapshot.recentActivityDaily`, recent records, and the same ingestion diagnostics. The UI should progress from RECONSTRUCTING to LIVE, with retained activity restored. Use port 3000 instead of 3002 for a local non-Compose instance.

## Development checks

```sh
npm test
npm run build
```

The regression scenarios use isolated caches and local HTTP/WebSocket fixtures to exercise sequence-reset recovery and archive-to-live cutover without contacting production.
