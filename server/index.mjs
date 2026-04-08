import https from "node:https";
import { Buffer } from "node:buffer";
import express from "express";
import dotenv from "dotenv";
import devcert from "@adobe/ccweb-add-on-devcert";

dotenv.config({ path: ".env.local" });

const FASHN_API_KEY  = process.env.FASHN_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!FASHN_API_KEY && (!OPENAI_API_KEY || OPENAI_API_KEY === "YOUR_OPENAI_API_KEY")) {
  console.error(
    "No usable API key found.\n" +
    "Set FASHN_API_KEY in .env.local (recommended) — get a free key at https://fashn.ai\n" +
    "Or keep OPENAI_API_KEY (faces may change with OpenAI fallback)."
  );
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "25mb" }));

app.use((req, res, next) => {
  const origin = req.headers.origin;
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
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// ── Fashn.ai — dedicated virtual try-on, identity-preserving ─────────────────
async function generateWithFashn(personDataUrl, garmentDataUrl, fitStyle) {
  // Fashn.ai accepts base64 data URLs directly
  const body = {
    model_image:   personDataUrl,
    garment_image: garmentDataUrl,
    category:      "tops",   // tops covers shirts, jackets, dresses, etc.
    mode:          "quality",
    garment_photo_type: "auto",
    // cover_feet keeps shoes unchanged; restore_background keeps bg identical
    cover_feet:          false,
    adjust_hands:        true,
    restore_background:  true,
    restore_clothes:     false,
    flat_lay:            false,
    long_top:            false,
  };

  // Step 1 — submit job
  const runRes = await fetch("https://api.fashn.ai/v1/run", {
    method:  "POST",
    headers: {
      Authorization:  `Bearer ${FASHN_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!runRes.ok) {
    const txt = await runRes.text().catch(() => "");
    throw new Error(`Fashn.ai run failed (${runRes.status}): ${txt.slice(0, 300)}`);
  }

  const { id } = await runRes.json();
  if (!id) throw new Error("Fashn.ai did not return a prediction id.");

  console.log("[FitAI] Fashn.ai job started:", id);

  // Step 2 — poll until completed (max ~120 s)
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));

    const statusRes = await fetch(`https://api.fashn.ai/v1/status/${id}`, {
      headers: { Authorization: `Bearer ${FASHN_API_KEY}` },
    });

    if (!statusRes.ok) continue;

    const data = await statusRes.json();
    console.log("[FitAI] Fashn.ai status:", data.status);

    if (data.status === "completed") {
      const url = Array.isArray(data.output) ? data.output[0] : data.output;
      if (!url) throw new Error("Fashn.ai completed but returned no output URL.");
      return url; // HTTPS image URL — send directly to frontend
    }

    if (data.status === "failed" || data.status === "error") {
      throw new Error(`Fashn.ai job failed: ${JSON.stringify(data.error ?? data)}`);
    }
    // statuses: starting | processing | completed | failed
  }

  throw new Error("Fashn.ai timed out after 120 s.");
}

// ── OpenAI fallback (gpt-4.1 Responses API) ───────────────────────────────────
function buildPrompt(fitStyle) {
  const fitDesc =
    { tight: "tight and form-fitting", regular: "regular and natural", oversized: "oversized and loose" }[fitStyle]
    ?? "regular and natural";

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
          { type: "input_text",  text: buildPrompt(fitStyle) },
          { type: "input_image", image_url: personDataUrl },
          { type: "input_image", image_url: garmentDataUrl },
        ],
      },
    ],
    tools: [{ type: "image_generation", action: "edit" }],
  };

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization:  `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`OpenAI Responses API failed (${res.status}): ${txt.slice(0, 300)}`);
  }

  const json = await res.json();
  const b64  = json?.output
    ?.filter((o) => o?.type === "image_generation_call")
    ?.map((o) => o?.result)
    ?.find(Boolean);

  if (!b64) throw new Error("OpenAI did not return an image.");
  return `data:image/png;base64,${b64}`;
}

// ── /tryon endpoint ───────────────────────────────────────────────────────────
app.post("/tryon", async (req, res) => {
  const { personDataUrl, garmentDataUrl, fitStyle } = req.body ?? {};

  if (!personDataUrl || !garmentDataUrl) {
    return res.status(400).json({ error: "Missing personDataUrl or garmentDataUrl" });
  }

  try {
    let url;

    if (FASHN_API_KEY) {
      console.log("[FitAI] Using Fashn.ai (identity-preserving)");
      url = await generateWithFashn(personDataUrl, garmentDataUrl, fitStyle);
    } else {
      console.warn("[FitAI] No FASHN_API_KEY — falling back to OpenAI (face may change).");
      url = await generateWithOpenAI(personDataUrl, garmentDataUrl, fitStyle);
    }

    return res.json({ url });
  } catch (e) {
    console.error("[FitAI] Error:", e?.message);
    return res.status(500).json({ error: e?.message || "Server error" });
  }
});

// ── Start HTTPS server ────────────────────────────────────────────────────────
const port     = 5242;
const hostname = "localhost";
const ssl      = await devcert.certificateFor(hostname);

https.createServer(ssl, app).listen(port, hostname, () => {
  console.log(`FitAI API proxy running at https://${hostname}:${port}`);
  if (FASHN_API_KEY) {
    console.log("[FitAI] Mode: Fashn.ai (face-preserving virtual try-on)");
  } else {
    console.log("[FitAI] Mode: OpenAI fallback (add FASHN_API_KEY for better results)");
  }
});
