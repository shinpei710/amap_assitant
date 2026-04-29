# Deployment

`amap_assitant` needs a Node.js backend because short links and detailed addresses are resolved by launching Chromium and reading the final map URL.

## Recommended: Docker Host

Use this path for Render, Fly.io, Railway, a VPS, or any platform that can run a long-lived Docker container.

```bash
docker build -t amap_assitant .
docker run --rm -p 5173:5173 amap_assitant
```

Required environment:

- `PORT`: defaults to `5173`
- `CHROMIUM_PATH`: defaults to `/usr/bin/chromium` in the Docker image
- `CONTACT_EMAIL`: optional; used in outbound API user-agent strings

Health check:

```text
/api/health
```

## Vercel Notes

Vercel can host the static frontend and supports Node.js Functions under `/api`, but this project does not deploy to Vercel as-is because `server.js` is a long-lived HTTP server and browser resolution currently depends on a system Chromium binary.

To make a Vercel version, the backend should be refactored into Vercel Functions and Chromium should be bundled with a serverless-compatible package such as `@sparticuz/chromium` plus `puppeteer-core`, or the frontend should call a separate Docker/VPS backend.

Recommended Vercel-compatible split:

1. Deploy the static files on Vercel.
2. Deploy the Node/Chromium API on a Docker host.
3. Point frontend API requests to that backend with an environment variable.

For a first public release, the single Docker service is simpler and closer to the current implementation.
