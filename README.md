# image-service

Shared image-generation service for all CHC/KITT apps (Flywheel, Script Shaper,
self-coach, blog) -- built so no app has to embed its own image generation.

Built 2026-09-01 after finding `hypnobrain-script-shaper/server/image-service.ts`
was a separate, broken implementation calling the deprecated `dall-e-3` model.
Ports the real, working Gemini image-generation call from
`kitt/tools/nano_banana_worker.py`'s `generate_with_gemini()` -- same endpoint,
same model (`gemini-3.1-flash-image`), same response parsing -- but as a plain
Cloudflare Worker with a real HTTP API, and calling Gemini's raw interactions
API directly rather than the Python tool's higher-level wrapper, which means
this version accepts arbitrary prompts instead of being limited to the
Python tool's 3 hardcoded visual-direction templates (Moonlit River, Bedside
Window, Soft Fractal Sky).

## API

`POST /generate` -- `{ "prompt": "...", "aspectRatio": "1:1", "slug": "optional-name" }`
returns `{ ok, key, url }`. Generates via Gemini, stores in R2 (`chc-media`
bucket, `images/` prefix), returns a public URL served by this same Worker.

`GET /images/:key` -- serves a generated image back from R2.

`GET /health` -- health check.

## Secrets

`GEMINI_API_KEY` -- set via `wrangler secret put GEMINI_API_KEY`, not a `.env`
file. This is the point: one real credential, managed in Cloudflare, not
scattered across every repo's own `.env` (a real problem hit 2026-09-01 while
building this -- one repo had a placeholder value never replaced, another had
the real working key, took real searching to find it).

## Next

- Script Shaper's own API is planned to move here too (per Erika, 2026-09-01),
  UI later if wanted.
- Not yet handling video-still generation (1 image/minute) or the ambient-scene
  video format -- see `chc-ai-operating-system/docs/spec_image_generation.md`
  for the full real spec this service is meant to eventually cover.
