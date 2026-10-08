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

Open <http://localhost:3000>. The app resolves the handle and connects to the configured Jetstream service. `JETSTREAM_API_KEY` is optional. Activity is stored in `data/at-me.db`; keep this file to retain history across restarts.
When the public Bluesky profile includes an avatar, the dashboard shows it beside the display name and handle.
The favicon is a circular monochrome badge with a transparent `@` cutout, adapting to light and dark browser themes. The browser tab title uses the resolved profile handle, so it appears beside the `@` favicon. The letterform is outlined from [IBM Plex Sans](https://github.com/google/fonts/tree/main/ofl/ibmplexsans) (SIL Open Font License), with no runtime font dependency.

## Run with Docker

Set `TARGET_HANDLE` in `.env`, then build and run:

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
| `JETSTREAM_API_KEY` | *(empty)* | Optional Jetstream API key. |
