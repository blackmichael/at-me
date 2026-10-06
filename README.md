# Atmosphere Identity

A self-hosted dashboard for an AT Protocol account. It reads repository events from a Jetstream service, stores local history, and updates the dashboard as new events arrive.

## Run locally

Requires Node.js 22.15 or newer.

```sh
npm install
cp .env.example .env
```

Edit `.env` and set `TARGET_HANDLE` to the AT Protocol handle you want to follow, then start the app:

```sh
npm run dev
```

Open <http://localhost:3000>. The app resolves the handle and connects to the configured Jetstream service. `JETSTREAM_API_KEY` is optional. Activity is stored at `DATABASE_PATH` (default `./data/at-me.db`); keep this file to retain history across restarts.

## Run with Docker

Set `TARGET_HANDLE` in `.env`, then build and run:

```sh
docker build -t at-me .
docker run --rm --env-file .env -p 3000:3000 -v at-me-data:/app/data at-me
```

The named volume keeps the database when the container is replaced.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `TARGET_HANDLE` | Set this in `.env` | AT Protocol handle to follow. The example value is a placeholder. |
| `PORT` | `3000` | HTTP listen port. |
| `JETSTREAM_SERVICE` | `https://jetstream.us-east.bsky.network` | Jetstream endpoint. |
| `JETSTREAM_API_KEY` | *(empty)* | Optional Jetstream API key. |
| `DATABASE_PATH` | `./data/at-me.db` | Path to the local history database. |
