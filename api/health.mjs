export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "OPTIONS") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(204).end();
  }

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  const hasFashn = Boolean(process.env.FASHN_API_KEY);
  const hasOpenAI = Boolean(process.env.OPENAI_API_KEY);

  return res.status(200).json({
    ok: true,
    service: "fitaiadobe",
    mode: hasFashn ? "fashn" : hasOpenAI ? "openai" : "missing_keys",
    time: new Date().toISOString()
  });
}

