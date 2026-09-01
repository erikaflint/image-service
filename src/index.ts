export interface Env {
  MEDIA_BUCKET: R2Bucket;
  GEMINI_API_KEY: string;
}

const INTERACTIONS_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
const DEFAULT_MODEL = "gemini-3.1-flash-image";

// Ported from kitt/tools/nano_banana_worker.py's generate_with_gemini(), same
// endpoint/model/request shape, confirmed working there before this port.
async function generateImage(prompt: string, apiKey: string, aspectRatio: string): Promise<ArrayBuffer> {
  const body = {
    model: DEFAULT_MODEL,
    input: [{ type: "text", text: prompt }],
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
      let body: { prompt?: string; aspectRatio?: string; slug?: string };
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

      let imageBytes: ArrayBuffer;
      try {
        imageBytes = await generateImage(prompt, env.GEMINI_API_KEY, aspectRatio);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 502);
      }

      const slug = slugify(body.slug || prompt);
      const key = `images/${slug}-${Date.now()}.jpg`;

      await env.MEDIA_BUCKET.put(key, imageBytes, {
        httpMetadata: { contentType: "image/jpeg" },
      });

      const imageUrl = new URL(`/images/${key.replace("images/", "")}`, url.origin).toString();
      return json({ ok: true, key, url: imageUrl });
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
