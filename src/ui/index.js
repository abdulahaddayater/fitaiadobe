import addOnUISdk from "https://new.express.adobe.com/static/add-on-sdk/sdk.js";

// ── API selection ─────────────────────────────────────────────────────────────
// Local is fastest for dev, but hosted add-ons cannot reach loopback.
const LOCAL_API_BASE_URL = "https://localhost:5242";
const VERCEL_API_BASE_URL = "https://fitaiadobe.vercel.app";

let resolvedApiBaseUrl = null;
async function getApiBaseUrl() {
    if (resolvedApiBaseUrl) return resolvedApiBaseUrl;

    // If we're clearly running on Adobe-hosted origin, never try loopback.
    const host = window.location.hostname || "";
    const isAdobeHosted = /\.wxp\.adobe-addons\.com$/i.test(host);
    if (isAdobeHosted) {
        resolvedApiBaseUrl = VERCEL_API_BASE_URL;
        return resolvedApiBaseUrl;
    }

    // If we're on localhost, prefer local API but fall back to Vercel if it's down.
    if (host === "localhost") {
        try {
            const controller = new AbortController();
            const t = setTimeout(() => controller.abort(), 800);
            const res = await fetch(`${LOCAL_API_BASE_URL}/health`, { signal: controller.signal });
            clearTimeout(t);
            if (res.ok) {
                resolvedApiBaseUrl = LOCAL_API_BASE_URL;
                return resolvedApiBaseUrl;
            }
        } catch {
            // ignore; fall back below
        }
    }

    resolvedApiBaseUrl = VERCEL_API_BASE_URL;
    return resolvedApiBaseUrl;
}

// Hidden, always-sent prompt notes (not shown in UI)
const EXTRA_PROMPT =
    "Only replace the person's clothing with the provided garment. " +
    "Do not change face, hair, hands, pose/gesture, body size/proportions, shoes, background, or camera framing.";

// ── State ────────────────────────────────────────────────────────────────────
const state = {
    personDataUrl:  null,   // base64 data-URL of uploaded person photo
    garmentDataUrl: null,   // base64 data-URL of uploaded garment photo
    selectedFit:    "regular",
    resultUrl:      null,   // final image URL returned by Replicate
};

// ── DOM refs ─────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const personZone     = $("person-zone");
const personInput    = $("person-input");
const personPreview  = $("person-preview");

const garmentZone    = $("garment-zone");
const garmentInput   = $("garment-input");
const garmentPreview = $("garment-preview");

const btnGenerate    = $("btn-generate");
const processingCard = $("processing-card");
const procSub        = $("proc-sub");

const resultSection  = $("result-section");
const resultImg      = $("result-img");
const btnAddToCanvas = $("btn-add-to-canvas");
const btnReset       = $("btn-reset");

const toastEl = $("toast");

// ── Helpers ──────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

let toastTimer;
function showToast(msg, type = "") {
    toastEl.textContent = msg;
    toastEl.className = `toast ${type} show`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 3500);
}

function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload  = e => resolve(e.target.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

// ── Processing step UI ────────────────────────────────────────────────────────
const STEP_IDS = ["ps-1", "ps-2", "ps-3", "ps-4"];

function resetSteps() {
    STEP_IDS.forEach(id => $(id).classList.remove("active", "done"));
}

function setStep(index, label) {
    // mark all previous as done
    STEP_IDS.forEach((id, i) => {
        const el = $(id);
        el.classList.remove("active", "done");
        if (i < index)  el.classList.add("done");
        if (i === index) el.classList.add("active");
    });
    procSub.textContent = label;
}

function allStepsDone() {
    STEP_IDS.forEach(id => {
        const el = $(id);
        el.classList.remove("active");
        el.classList.add("done");
    });
}

async function runTryOn() {
    setStep(0, "Sending request…");

    const payload = {
        personDataUrl: state.personDataUrl,
        garmentDataUrl: state.garmentDataUrl,
        fitStyle: state.selectedFit,
        extraPrompt: EXTRA_PROMPT,
    };

    const API_BASE_URL = await getApiBaseUrl();

    console.group("[FitAI] Local try-on request");
    console.log("URL:", `${API_BASE_URL}/tryon`);
    console.log("Payload:", {
        ...payload,
        // Keep logs readable
        personDataUrl: payload.personDataUrl ? `dataUrl(${payload.personDataUrl.length} chars)` : null,
        garmentDataUrl: payload.garmentDataUrl ? `dataUrl(${payload.garmentDataUrl.length} chars)` : null,
    });
    console.groupEnd();

    setStep(1, "Generating…");
    const res = await fetch(`${API_BASE_URL}/tryon`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });

    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Try-on request failed (${res.status}). ${text}`);
    }

    const json = await res.json();
    if (!json?.url) throw new Error("No result url returned.");

    if (json?.promptUsed) {
        console.group("[FitAI] Prompt used (server-side)");
        console.log(json.promptUsed);
        console.groupEnd();
    }

    allStepsDone();
    return json.url;
}

// ── Generate handler ──────────────────────────────────────────────────────────
btnGenerate.addEventListener("click", async () => {
    btnGenerate.disabled = true;
    resultSection.classList.remove("visible");
    processingCard.classList.add("visible");
    resetSteps();
    state.resultUrl = null;

    try {
        const url = await runTryOn();

        state.resultUrl = url;
        resultImg.src   = url;
        resultSection.classList.add("visible");
        showToast("Try-on ready!", "success");

    } catch (err) {
        console.error("[FitAI] Generation error:", err);
        showToast(err.message || "Something went wrong. Try again.", "error");
    } finally {
        processingCard.classList.remove("visible");
        btnGenerate.disabled = false;
    }
});

// ── Add to Editor ─────────────────────────────────────────────────────────────
btnAddToCanvas.addEventListener("click", async () => {
    if (!state.resultUrl) return;

    btnAddToCanvas.disabled    = true;
    btnAddToCanvas.textContent = "Adding…";

    try {
        // Fetch the result image as a Blob, then hand it to Adobe Express
        const blob = await fetch(state.resultUrl).then(r => {
            if (!r.ok) throw new Error(`Could not fetch result image (${r.status})`);
            return r.blob();
        });

        await addOnUISdk.app.document.addImage(blob);
        showToast("Image added to editor!", "success");

    } catch (err) {
        console.error("[FitAI] Add to canvas error:", err);
        showToast(err.message || "Could not add image. Try again.", "error");
    } finally {
        btnAddToCanvas.disabled    = false;
        btnAddToCanvas.textContent = "Add to Editor";
    }
});

// ── Reset ─────────────────────────────────────────────────────────────────────
btnReset.addEventListener("click", () => {
    state.personDataUrl  = null;
    state.garmentDataUrl = null;
    state.resultUrl      = null;
    state.selectedFit    = "regular";

    // Clear person upload zone
    personInput.value        = "";
    personPreview.src        = "";
    personPreview.style.display = "none";
    personZone.classList.remove("loaded");
    personZone.querySelectorAll(".upload-icon, .upload-hint")
        .forEach(el => { el.style.display = ""; });

    // Clear garment upload zone
    garmentInput.value          = "";
    garmentPreview.src          = "";
    garmentPreview.style.display = "none";
    garmentZone.classList.remove("loaded");
    garmentZone.querySelectorAll(".upload-icon, .upload-hint")
        .forEach(el => { el.style.display = ""; });

    // Reset fit buttons
    document.querySelectorAll(".fit-btn").forEach(b => {
        b.classList.toggle("selected", b.dataset.fit === "regular");
    });

    // Hide result
    resultSection.classList.remove("visible");
    resultImg.src = "";

    updateGenerateBtn();
    showToast("Reset — upload new images to start.", "");
});

// ── Upload zones ──────────────────────────────────────────────────────────────
function setupUploadZone(zone, input, previewEl, onLoad) {
    async function handleFile(file) {
        if (!file || !file.type.startsWith("image/")) {
            showToast("Please upload a valid image file.", "error");
            return;
        }
        try {
            const dataUrl = await readFileAsDataUrl(file);
            previewEl.src          = dataUrl;
            previewEl.style.display = "block";
            zone.querySelectorAll(".upload-icon, .upload-hint")
                .forEach(el => { el.style.display = "none"; });
            zone.classList.add("loaded");
            onLoad(dataUrl);
            updateGenerateBtn();
        } catch {
            showToast("Could not load image. Try again.", "error");
        }
    }

    input.addEventListener("change", () => {
        if (input.files[0]) handleFile(input.files[0]);
    });

    zone.addEventListener("dragover", e => {
        e.preventDefault();
        zone.classList.add("dragover");
    });
    zone.addEventListener("dragleave", () => zone.classList.remove("dragover"));
    zone.addEventListener("drop", e => {
        e.preventDefault();
        zone.classList.remove("dragover");
        handleFile(e.dataTransfer.files[0]);
    });
}

function updateGenerateBtn() {
    btnGenerate.disabled = !(state.personDataUrl && state.garmentDataUrl);
}

// ── Fit buttons ───────────────────────────────────────────────────────────────
document.querySelectorAll(".fit-btn").forEach(btn => {
    btn.addEventListener("click", () => {
        document.querySelectorAll(".fit-btn").forEach(b => b.classList.remove("selected"));
        btn.classList.add("selected");
        state.selectedFit = btn.dataset.fit;
    });
});

// ── SDK init ──────────────────────────────────────────────────────────────────
addOnUISdk.ready.then(() => {
    setupUploadZone(
        personZone, personInput, personPreview,
        dataUrl => { state.personDataUrl = dataUrl; }
    );
    setupUploadZone(
        garmentZone, garmentInput, garmentPreview,
        dataUrl => { state.garmentDataUrl = dataUrl; }
    );
});
