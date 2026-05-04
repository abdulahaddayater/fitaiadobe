function setCors(req, res) {
  const origin = req.headers?.origin;
  const allowed =
    origin === "https://localhost:5241" ||
    (typeof origin === "string" && /^https:\/\/[a-z0-9-]+\.wxp\.adobe-addons\.com$/i.test(origin));

  if (allowed && origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

const FASHN_API_KEY = process.env.FASHN_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

async function generateWithFashn(personDataUrl, garmentDataUrl) {
  const body = {
    model_image: personDataUrl,
    garment_image: garmentDataUrl,
    category: "tops",
    mode: "quality",
    garment_photo_type: "auto",
    cover_feet: false,
    adjust_hands: true,
    restore_background: true,
    restore_clothes: false,
    flat_lay: false,
    long_top: false
  };

  const runRes = await fetch("https://api.fashn.ai/v1/run", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${FASHN_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!runRes.ok) {
    const txt = await runRes.text().catch(() => "");
    throw new Error(`Fashn.ai run failed (${runRes.status}): ${txt.slice(0, 300)}`);
  }

  const { id } = await runRes.json();
  if (!id) throw new Error("Fashn.ai did not return a prediction id.");

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));

    const statusRes = await fetch(`https://api.fashn.ai/v1/status/${id}`, {
      headers: { Authorization: `Bearer ${FASHN_API_KEY}` }
    });
    if (!statusRes.ok) continue;

    const data = await statusRes.json();
    if (data.status === "completed") {
      const url = Array.isArray(data.output) ? data.output[0] : data.output;
      if (!url) throw new Error("Fashn.ai completed but returned no output URL.");
      return url;
    }
    if (data.status === "failed" || data.status === "error") {
      throw new Error(`Fashn.ai job failed: ${JSON.stringify(data.error ?? data)}`);
    }
  }

  throw new Error("Fashn.ai timed out after 120 s.");
}

function buildPrompt(fitStyle) {
  const fitDesc =
    { tight: "tight and form-fitting", regular: "regular and natural", oversized: "oversized and loose" }[fitStyle] ??
    "regular and natural";

  return `You are an AI virtual try-on system.

Task:
Replace ONLY the garment worn by the person in the original image with the provided garment image. Apply it with a ${fitDesc} fit.

STRICT RULES (VERY IMPORTANT):
- Do NOT change the person's face, identity, body shape, skin tone, hairstyle, or expression
- Do NOT change pose, camera angle, lighting, shadows, or background
- Do NOT modify any accessories (glasses, jewelry, etc.)
- Do NOT enhance, stylize, beautify, or alter the image in any way
- Do NOT change colors of anything except the garment
- Do NOT apply filters or artistic effects

Garment Rules:
- Accurately fit the garment onto the body with a ${fitDesc} fit
- Maintain realistic folds, shadows, and alignment
- Preserve original proportions and perspective
- Ensure natural blending with lighting and body position

Output Requirements:
- The final image must look identical to the original except for the garment change
- High realism is required
- No additional modifications or improvements

If the garment cannot be applied correctly, return the original image unchanged.`;
}

async function generateWithOpenAI(personDataUrl, garmentDataUrl, fitStyle) {
  const payload = {
    model: "gpt-4.1",
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: buildPrompt(fitStyle) },
          { type: "input_image", image_url: personDataUrl },
          { type: "input_image", image_url: garmentDataUrl }
        ]
      }
    ],
    tools: [{ type: "image_generation", action: "edit" }]
  };

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`OpenAI Responses API failed (${res.status}): ${txt.slice(0, 300)}`);
  }

  const json = await res.json();
  const b64 = json?.output
    ?.filter((o) => o?.type === "image_generation_call")
    ?.map((o) => o?.result)
    ?.find(Boolean);

  if (!b64) throw new Error("OpenAI did not return an image.");
  return `data:image/png;base64,${b64}`;
}

function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  if (!FASHN_API_KEY && !OPENAI_API_KEY) {
    return res.status(500).json({ error: "Server missing API keys (set FASHN_API_KEY or OPENAI_API_KEY in Vercel env)." });
  }

  try {
    const body = await readJsonBody(req);
    const { personDataUrl, garmentDataUrl, fitStyle } = body ?? {};

    if (!personDataUrl || !garmentDataUrl) {
      return res.status(400).json({ error: "Missing personDataUrl or garmentDataUrl" });
    }

    const url = FASHN_API_KEY
      ? await generateWithFashn(personDataUrl, garmentDataUrl)
      : await generateWithOpenAI(personDataUrl, garmentDataUrl, fitStyle);

    return res.status(200).json({ url });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Server error" });
  }
}

