import addOnSandboxSdk from "add-on-sdk-document-sandbox";
import { editor } from "express-document-sdk";

const { runtime } = addOnSandboxSdk.instance;

// Convert a base64 DataURL to a Uint8Array blob
function dataUrlToUint8Array(dataUrl) {
    const base64 = dataUrl.split(",")[1];
    const binary  = atob(base64);
    const bytes   = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

// Detect MIME type from DataURL header
function mimeFromDataUrl(dataUrl) {
    const match = dataUrl.match(/^data:([^;]+);base64,/);
    return match ? match[1] : "image/png";
}

function start() {
    const sandboxApi = {
        /**
         * Add the virtual try-on result image to the active Express canvas.
         * @param {string} dataUrl  - base64 DataURL of the result image
         */
        addImageToCanvas: async (dataUrl) => {
            try {
                const mimeType  = mimeFromDataUrl(dataUrl);
                const imageData = dataUrlToUint8Array(dataUrl);
                const blob      = new Blob([imageData], { type: mimeType });

                // Create a bitmap image element and append to the document
                const imageContainer = await editor.createImageContainer(blob, {
                    title: "Virtual Try-On Result",
                });

                // Place at a sensible default position
                imageContainer.translation = { x: 20, y: 20 };

                const insertionParent = editor.context.insertionParent;
                insertionParent.children.append(imageContainer);

                return { success: true };
            } catch (err) {
                console.error("[Sandbox] addImageToCanvas error:", err);
                throw err;
            }
        },

        /**
         * Get the current document title (used to verify sandbox connection).
         */
        getDocumentTitle: () => {
            try {
                return editor.documentRoot?.name ?? "Untitled";
            } catch {
                return "Untitled";
            }
        },
    };

    runtime.exposeApi(sandboxApi);
}

start();
