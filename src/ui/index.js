import addOnUISdk from "https://new.express.adobe.com/static/add-on-sdk/sdk.js";

// ── API selection ─────────────────────────────────────────────────────────────
// Deployed backend (Vercel) for submitted add-on / other devices
const VERCEL_API_BASE_URL = "https://fitaibackend-gamma.vercel.app";

let resolvedApiBaseUrl = null;
async function getApiBaseUrl() {
    if (resolvedApiBaseUrl) return resolvedApiBaseUrl;

    // Always use Vercel so requests never go to localhost.
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
    personFile:     null,   // original File object (for multipart upload)
    garmentFile:    null,   // original File object (for multipart upload)
    selectedFit:    "regular",
    resultUrl:      null,   // final image URL returned by Replicate
    isGenerating:   false,
};

// ── DOM refs ─────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const personZone     = $("person-zone");
const personInput    = $("person-input");
const personPreview  = $("person-preview");
const personHelper   = $("person-helper");

const garmentZone    = $("garment-zone");
const garmentInput   = $("garment-input");
const garmentPreview = $("garment-preview");
const garmentHelper  = $("garment-helper");

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

function setGenerating(isGenerating) {
    state.isGenerating = isGenerating;

    // Lock uploads
    personInput.disabled = isGenerating;
    garmentInput.disabled = isGenerating;
    personZone.classList.toggle("locked", isGenerating);
    garmentZone.classList.toggle("locked", isGenerating);

    // Lock fit controls
    document.querySelectorAll(".fit-btn").forEach((b) => { b.disabled = isGenerating; });

    // Lock actions
    btnReset.disabled = isGenerating;
    btnAddToCanvas.disabled = isGenerating || !state.resultUrl;
}

function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload  = e => resolve(e.target.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

const SUPPORTED_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);
const SUPPORTED_IMAGE_EXTS  = new Set(["jpg", "jpeg", "png", "webp"]);

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

    const API_BASE_URL = await getApiBaseUrl();

    if (!state.personFile || !state.garmentFile) {
        throw new Error("Please upload both images first.");
    }

    const form = new FormData();
    form.append("fitStyle", state.selectedFit);
    form.append("extraPrompt", EXTRA_PROMPT);
    form.append("person_image", state.personFile, state.personFile.name || "person.png");
    form.append("garment_image", state.garmentFile, state.garmentFile.name || "garment.png");

    console.group("[FitAI] Local try-on request");
    console.log("URL:", `${API_BASE_URL}/fitAI/try-on`);
    console.log("fitStyle:", state.selectedFit);
    console.groupEnd();

    setStep(1, "Generating…");
    const res = await fetch(`${API_BASE_URL}/fitAI/try-on`, {
        method: "POST",
        body: form,
    });

    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Try-on request failed (${res.status}). ${text}`);
    }

    const json = await res.json();
    const outUrl = json?.url || json?.image_url;
    if (!outUrl) throw new Error("No result url returned.");

    if (json?.promptUsed) {
        console.group("[FitAI] Prompt used (server-side)");
        console.log(json.promptUsed);
        console.groupEnd();
    }

    allStepsDone();
    return outUrl;
}

// ── Generate handler ──────────────────────────────────────────────────────────
btnGenerate.addEventListener("click", async () => {
    btnGenerate.disabled = true;
    resultSection.classList.remove("visible");
    processingCard.classList.add("visible");
    resetSteps();
    state.resultUrl = null;
    setGenerating(true);

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
        setGenerating(false);
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
    if (state.isGenerating) return;
    state.personDataUrl  = null;
    state.garmentDataUrl = null;
    state.personFile     = null;
    state.garmentFile    = null;
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
    setGenerating(false);
    showToast("Reset — upload new images to start.", "");
});

// ── Upload zones ──────────────────────────────────────────────────────────────
function setupUploadZone(zone, input, previewEl, helperEl, onLoad) {
    function setHelper(msg, type = "") {
        if (!helperEl) return;
        helperEl.textContent = msg || "";
        helperEl.classList.toggle("error", type === "error");
    }

    function isSupportedImage(file) {
        if (!file) return false;
        if (file.type && SUPPORTED_IMAGE_MIMES.has(file.type)) return true;
        const name = (file.name || "").toLowerCase();
        const ext = name.includes(".") ? name.split(".").pop() : "";
        return SUPPORTED_IMAGE_EXTS.has(ext);
    }

    async function handleFile(file) {
        if (state.isGenerating) return;
        if (!file) return;
        if (!file.type?.startsWith("image/") && !file.name) {
            setHelper("Please upload a valid image file.", "error");
            showToast("Please upload a valid image file.", "error");
            return;
        }
        if (!isSupportedImage(file)) {
            input.value = "";
            previewEl.src = "";
            previewEl.style.display = "none";
            zone.classList.remove("loaded");
            zone.querySelectorAll(".upload-icon, .upload-hint")
                .forEach(el => { el.style.display = ""; });
            setHelper("Unsupported image format. Please use JPG/JPEG, PNG, or WEBP.", "error");
            showToast("Unsupported image format.", "error");
            return;
        }
        try {
            setHelper("");
            const dataUrl = await readFileAsDataUrl(file);
            previewEl.src          = dataUrl;
            previewEl.style.display = "block";
            zone.querySelectorAll(".upload-icon, .upload-hint")
                .forEach(el => { el.style.display = "none"; });
            zone.classList.add("loaded");
            onLoad(dataUrl, file);
            updateGenerateBtn();
        } catch {
            setHelper("Could not load image. Try again.", "error");
            showToast("Could not load image. Try again.", "error");
        }
    }

    input.addEventListener("change", () => {
        if (state.isGenerating) return;
        if (input.files[0]) handleFile(input.files[0]);
    });

    zone.addEventListener("dragover", e => {
        if (state.isGenerating) return;
        e.preventDefault();
        zone.classList.add("dragover");
    });
    zone.addEventListener("dragleave", () => zone.classList.remove("dragover"));
    zone.addEventListener("drop", e => {
        if (state.isGenerating) return;
        e.preventDefault();
        zone.classList.remove("dragover");
        handleFile(e.dataTransfer.files[0]);
    });
}

function updateGenerateBtn() {
    btnGenerate.disabled = state.isGenerating || !(state.personDataUrl && state.garmentDataUrl);
}

// ── Fit buttons ───────────────────────────────────────────────────────────────
document.querySelectorAll(".fit-btn").forEach(btn => {
    btn.addEventListener("click", () => {
        if (state.isGenerating) return;
        document.querySelectorAll(".fit-btn").forEach(b => b.classList.remove("selected"));
        btn.classList.add("selected");
        state.selectedFit = btn.dataset.fit;
    });
});

// ── SDK init ──────────────────────────────────────────────────────────────────
addOnUISdk.ready.then(() => {
    setupUploadZone(
        personZone, personInput, personPreview, personHelper,
        (dataUrl, file) => { state.personDataUrl = dataUrl; state.personFile = file; }
    );
    setupUploadZone(
        garmentZone, garmentInput, garmentPreview, garmentHelper,
        (dataUrl, file) => { state.garmentDataUrl = dataUrl; state.garmentFile = file; }
    );
    setGenerating(false);
});
