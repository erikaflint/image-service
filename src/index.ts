export interface Env {
  MEDIA_BUCKET: R2Bucket;
  GEMINI_API_KEY: string;
  IMAGES: ImagesBinding;
}

const INTERACTIONS_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
const DEFAULT_MODEL = "gemini-3.1-flash-image";
// cdn.cascadehypnosiscenter.com serves the same chc-media R2 bucket this
// Worker writes to (same key = same file, confirmed live 2026-09-01) -- this
// is the real, canonical asset domain the rest of the site/ecosystem
// expects, so it's what gets returned, not this Worker's own domain.
const CDN_BASE = "https://cdn.cascadehypnosiscenter.com";

// Ported from kitt/tools/nano_banana_worker.py's generate_with_gemini(), same
// endpoint/model/request shape, confirmed working there before this port.
// Extended to accept reference images (up to 14 per Gemini's real documented
// limit) so a generation can be visually anchored to prior output -- this is
// what makes "more like this" a real image-to-image variation instead of a
// fresh re-roll on the same text prompt, and what lets a batch of stills for
// one video actually look like they belong together.
async function generateImage(
  prompt: string,
  apiKey: string,
  aspectRatio: string,
  referenceImages: { data: string; mimeType: string }[] = [],
): Promise<ArrayBuffer> {
  const input: Array<Record<string, unknown>> = referenceImages
    .slice(0, 14)
    .map((ref) => ({ type: "image", data: ref.data, mime_type: ref.mimeType }));
  input.push({ type: "text", text: prompt });

  const body = {
    model: DEFAULT_MODEL,
    input,
    response_format: {
      type: "image",
      mime_type: "image/jpeg",
      aspect_ratio: aspectRatio,
    },
  };

  const response = await fetch(INTERACTIONS_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Gemini image request failed: HTTP ${response.status}: ${detail}`);
  }

  const payload: unknown = await response.json();
  const base64 = findBase64Image(payload);
  if (!base64) {
    throw new Error("Gemini response did not contain image data.");
  }

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

// Ported from find_base64_image() in the Python tool -- same recursive search
// across the possible response shapes Gemini's interactions API can return.
function findBase64Image(payload: unknown): string | null {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const obj = payload as Record<string, unknown>;
    const outputImage = obj.output_image as Record<string, unknown> | undefined;
    if (outputImage && typeof outputImage.data === "string") {
      return outputImage.data;
    }
    if (obj.type === "image" && typeof obj.data === "string") {
      return obj.data;
    }
    const inlineData = (obj.inlineData ?? obj.inline_data) as Record<string, unknown> | undefined;
    if (inlineData && typeof inlineData.data === "string") {
      return inlineData.data;
    }
    for (const value of Object.values(obj)) {
      const found = findBase64Image(value);
      if (found) return found;
    }
  }
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = findBase64Image(item);
      if (found) return found;
    }
  }
  return null;
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "image"
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/generate") {
      let body: { prompt?: string; aspectRatio?: string; slug?: string; referenceKeys?: string[] };
      try {
        body = await request.json();
      } catch {
        return json({ error: "Invalid JSON body" }, 400);
      }

      const prompt = body.prompt?.trim();
      if (!prompt) {
        return json({ error: "prompt is required" }, 400);
      }
      const aspectRatio = body.aspectRatio || "1:1";

      if (!env.GEMINI_API_KEY) {
        return json({ error: "GEMINI_API_KEY is not configured on this Worker" }, 500);
      }

      // Optional: anchor this generation to up to 14 existing images already
      // in this bucket (by key) -- real image-to-image input, for "more like
      // this" variations or keeping a batch of stills visually cohesive.
      const referenceImages: { data: string; mimeType: string }[] = [];
      for (const refKey of (body.referenceKeys || []).slice(0, 14)) {
        const normalizedKey = refKey.startsWith("images/") ? refKey : `images/${refKey}`;
        const object = await env.MEDIA_BUCKET.get(normalizedKey);
        if (!object) {
          return json({ error: `referenceKeys: not found: ${refKey}` }, 400);
        }
        const bytes = await object.arrayBuffer();
        let binary = "";
        const chunk = 8192;
        const view = new Uint8Array(bytes);
        for (let i = 0; i < view.length; i += chunk) {
          binary += String.fromCharCode(...view.subarray(i, i + chunk));
        }
        referenceImages.push({
          data: btoa(binary),
          mimeType: object.httpMetadata?.contentType || "image/jpeg",
        });
      }

      let imageBytes: ArrayBuffer;
      try {
        imageBytes = await generateImage(prompt, env.GEMINI_API_KEY, aspectRatio, referenceImages);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 502);
      }

      const slug = slugify(body.slug || prompt);
      const stamp = Date.now();
      const originalKey = `images/${slug}-${stamp}-original.jpg`;
      const webKey = `images/${slug}-${stamp}.webp`;

      await env.MEDIA_BUCKET.put(originalKey, imageBytes, {
        httpMetadata: { contentType: "image/jpeg" },
      });

      // Real web-ready variant, same folder as the original, clearly named --
      // Gemini's raw output runs 700-900KB, too large for actual site use.
      // Cap width at 1024 (native output size, so this is compression not
      // downscaling for typical use) and convert to WebP at quality 80.
      let webBytes: ArrayBuffer;
      try {
        const transformed = await env.IMAGES.input(new Response(imageBytes).body!)
          .transform({ width: 1024 })
          .output({ format: "image/webp", quality: 80 });
        webBytes = await transformed.response().arrayBuffer();
      } catch (error) {
        // If the Images binding fails for any reason, fall back to the
        // original rather than losing the generation entirely.
        webBytes = imageBytes;
      }

      await env.MEDIA_BUCKET.put(webKey, webBytes, {
        httpMetadata: { contentType: webBytes === imageBytes ? "image/jpeg" : "image/webp" },
      });

      return json({
        ok: true,
        key: webKey,
        url: `${CDN_BASE}/${webKey}`,
        original: { key: originalKey, url: `${CDN_BASE}/${originalKey}` },
      });
    }

    if (request.method === "GET" && url.pathname.startsWith("/images/")) {
      const key = `images/${url.pathname.replace("/images/", "")}`;
      const object = await env.MEDIA_BUCKET.get(key);
      if (!object) {
        return new Response("Not found", { status: 404 });
      }
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);
      headers.set("cache-control", "public, max-age=31536000, immutable");
      return new Response(object.body, { headers });
    }

    if (request.method === "GET" && url.pathname === "/images") {
      const cursor = url.searchParams.get("cursor") || undefined;
      const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);
      const listed = await env.MEDIA_BUCKET.list({ prefix: "images/", cursor, limit });
      const items = listed.objects
        .sort((a, b) => (b.uploaded?.getTime() ?? 0) - (a.uploaded?.getTime() ?? 0))
        .map((obj) => ({
          key: obj.key,
          url: new URL(`/images/${obj.key.replace("images/", "")}`, url.origin).toString(),
          size: obj.size,
          uploaded: obj.uploaded?.toISOString() ?? null,
        }));
      return json({
        ok: true,
        count: items.length,
        items,
        cursor: listed.truncated ? listed.cursor : null,
      });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "image-service" });
    }

    return json({ error: "Not found" }, 404);
  },
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
