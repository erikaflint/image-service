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

`POST /generate` -- `{ "prompt": "...", "aspectRatio": "1:1", "slug": "optional-name", "referenceKeys": ["images/existing-key.jpg"] }`
returns `{ ok, key, url, original: { key, url } }`. Generates via Gemini,
stores in R2 (`chc-media` bucket, `images/` prefix), returns a public URL
served from `cdn.cascadehypnosiscenter.com` (same bucket, confirmed live
2026-09-01). `referenceKeys` is optional -- up to 14 existing images
(Gemini's real documented limit) can be passed as real image-to-image input
alongside the text prompt, for genuine "more like this" variations or
keeping a batch of images (e.g. stills for one video) visually cohesive.
Verified live: generating from a reference image preserved the same
composition (same landscape, same building placement) while changing time
of day per the prompt -- a real variation, not a fresh random scene.

**Two files are stored per generation, in the same `images/` folder:**
Gemini's raw output runs 700-900KB, too large for actual site use, so every
generation also produces a web-ready variant via the Cloudflare Workers
Images binding (resized to max width 1024, converted to WebP, quality 80).
`key`/`url` in the response point to this web variant -- it's the one to
use on the site. `original.key`/`original.url` point at the full-size
source JPEG, kept alongside it for any future need (e.g. a higher-res
reprocess). Verified live 2026-09-01: a 659,634-byte original produced a
41,466-byte web variant -- a real ~16x reduction, not a token resize.

`GET /images/:key` -- serves a generated image back from R2.

`GET /images?limit=50&cursor=...` -- lists generated images (paginated,
newest first). R2's own dashboard already covers manual browsing; this is
for apps/roles that need to list and pick images programmatically.

`GET /health` -- health check.

## Delivery Variants

This service creates source assets. Cloudflare should create delivery variants.

Once Image Transformations are enabled for the CHC zone and allowed to pull from
`cdn.cascadehypnosiscenter.com`, downstream code should prefer deterministic
Cloudflare transformation URLs over pre-generating a pile of files after each
image run.

Default pattern:

```text
Generate one good source image -> store it in R2 -> serve thumbnails, page
images, mobile/desktop sizes, WebP, and AVIF through Cloudflare.
```

Suggested starting sizes:

- gallery thumbnails: `width=300,format=auto`
- small inline images: `width=640,format=auto`
- standard page images: `width=1024,format=auto`
- wide hero/social review images: `width=1600,format=auto`

Do not add another image-generation implementation in other apps, and do not
generate every WebP/thumbnail/mobile/desktop variant as a physical file unless a
specific downstream platform genuinely needs files rather than transformed URLs.

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
