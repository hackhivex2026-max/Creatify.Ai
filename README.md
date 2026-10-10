# Creatify AI backend

Zero-dependency Node backend (Node 22.13+). Data lives in SQLite (`data/creatify.db`, created on first run) and the 11 creators from your prototype are seeded automatically.

## Run
```
cp .env.example .env      # optional; Node does not read .env by itself, so export the variables or use: node --env-file=.env server.js
npm start                 # http://localhost:8787 (also serves public/index.html)
npm test                  # smoke test of auth, briefs, matching, applications, jobs
```

## AI Studio (works with no frontend changes)
Open AI Studio → Settings and set the backend URL to `http://localhost:8787`. The prototype already calls `POST /jobs` and `GET /jobs/:id`; this server implements that exact contract, enforces the same model rules and a daily limit (`DAILY_JOB_LIMIT`). Without a provider it returns demo output. To use a real model service, set `PROVIDER_URL` and `PROVIDER_KEY` (it must expose `POST /jobs` and `GET /jobs/:id`).

## Video with Magic Hour (recommended)
Set `MAGICHOUR_KEY` in `.env` (key from magichour.ai/developer). All video jobs then go to Magic Hour's text-to-video API; the backend polls `GET /v1/video-projects/{id}`, saves the finished mp4 to `data/media/` (their download links expire) and serves it from `/media/`. Images keep using the free Pollinations provider. Notes: reference-image video is not connected (the server returns a clear error), the free plan allows 480p only and may watermark, and free use is non-commercial. Tested against a mock of their documented API (`test/mh.mjs`); do one real generation to confirm with your key.

## Free generation setup
Provider order: `PROVIDER_URL` > `MAGICHOUR_KEY` (video only) > `FAL_KEY` > `HF_TOKEN` > keyless default.
- **Images, no setup:** free Pollinations is used automatically; "Number of images" is honoured (1-4).
- **Images + video, free:** create a Hugging Face token, set `HF_TOKEN`, and for video also `HF_VIDEO_URL`. Results are saved in `data/media/` and served from `/media/`. If Hugging Face fails for an image, the job falls back to Pollinations. Video has no free fallback, so a failure is shown honestly.
- Free credits are small; `DAILY_JOB_LIMIT` protects them. The Hugging Face path is tested against a mock (`test/hf.mjs`); try it once with your real token.

## API (JSON, `Authorization: Bearer <token>` where marked 🔒)
| Area | Endpoints |
|---|---|
| Auth | `POST /api/auth/register` (role: brand or creator), `POST /api/auth/login`, 🔒 `GET /api/me` |
| Creators | `GET /api/creators?q=&spec=&tool=&type=&format=&comm=1&ver=1`, `GET /api/creators/:id`, 🔒 `PUT /api/creators/:id` (owner only), 🔒 `POST /api/creators/:id/projects`, 🔒 `DELETE /api/creators/:id/projects/:pid` |
| Saved | 🔒 `GET /api/saved`, 🔒 `PUT/DELETE /api/saved/:creatorId` |
| Briefs | 🔒 `GET/POST /api/briefs`, 🔒 `GET/PUT/DELETE /api/briefs/:id`, 🔒 `POST /api/briefs/:id/publish`, 🔒 `GET /api/briefs/:id/matches` |
| Applications | 🔒 `POST /api/briefs/:id/applications`, 🔒 `GET /api/briefs/:id/applications` (brand), 🔒 `GET /api/applications` (mine), 🔒 `PATCH /api/applications/:id` (Shortlisted / Accepted / Rejected by brand, Withdrawn by creator) |
| Hiring | 🔒 `POST /api/creators/:id/hire` (brand only; `message`, optional `briefId`), 🔒 `GET /api/hires` (brands: sent, creators: received), 🔒 `PATCH /api/hires/:id` (creator: Accepted / Declined, brand: Cancelled) |
| Assets | 🔒 `GET/POST /api/assets`, 🔒 `DELETE /api/assets/:id` |
| AI jobs | `POST /jobs`, `GET /jobs/:id` (also under `/api/jobs`), 🔒 `GET /api/jobs`, `GET /api/models` |

Security included: scrypt password hashing, signed 7-day tokens, ownership checks on every write, input validation with field-level errors, rate limiting, 1 MB body limit, CORS allow-list (`ALLOWED_ORIGINS`), safe-URL checks, security headers.

## Frontend connection
`public/index.html` now talks to this API when the server is reachable (it tries the AI Studio backend URL, the page's own origin, then `http://localhost:8787`). Log in / sign up is in the top bar. Connected: accounts, Discover creators, saved creators, briefs (draft, publish, edit, delete), applications (creators apply, brands shortlist/accept/reject), the Creator Workspace (profile + portfolio, creator accounts only) and AI Studio brief publishing. If the server is unreachable the page falls back to the old browser-storage demo mode.

## Not done yet
AI Studio's saved library and campaign still live in browser storage (`/api/assets` exists but is not wired in). Data already in browser storage is not migrated to an account. Before going public: HTTPS in front, a persistent disk for `data/`, a real `AUTH_SECRET`, a restrictive `ALLOWED_ORIGINS`, email verification, and real payments if you add paid orders.

## Deploy
1. Push this folder to a GitHub repository (`.gitignore` already keeps `.env`, the database and generated media out).
2. Host with Node 22.13+ and run `npm start`. On Render, "New → Blueprint" reads `render.yaml` (it adds a 1 GB persistent disk at `/var/data` for the database and generated videos; this needs a paid plan).
3. Set these environment variables: `MAGICHOUR_KEY` (your key), `AUTH_SECRET` (long random text), `DATA_DIR` (a persistent folder), `ALLOWED_ORIGINS` (your site address), and `PUBLIC_URL` (the site's public address, so generated-video links work).
4. Without a persistent disk, accounts, briefs and hire requests reset on every restart.
