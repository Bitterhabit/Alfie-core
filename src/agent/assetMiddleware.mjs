import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

const DATA_URI_EXACT_RE = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i;
const DATA_URI_INLINE_RE = /data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]{16,})/gi;
const BASE64_BODY_RE = /^[A-Za-z0-9+/]+={0,2}$/;

const IMAGE_HINT_KEYS = new Set([
  "image",
  "imagedata",
  "image_data",
  "imagebase64",
  "image_base64",
  "base64",
  "b64",
  "b64_json",
  "sprite",
  "spritesheet",
  "tileset",
  "texture",
  "pixmap",
  "bitmap",
  "png",
  "jpeg",
  "jpg",
  "webp",
  "gif",
  "svg",
  "binary",
  "bytes",
  "rawbytes",
  "raw_bytes"
]);

const MIME_TO_EXT = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
  "image/tiff": "tiff",
  "image/svg+xml": "svg",
  "image/avif": "avif",
  "application/octet-stream": "bin"
};

export function detectBinaryFormat(buffer, hintedMimeType = "") {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { mimeType: hintedMimeType || "application/octet-stream", ext: "bin", isImage: false };
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return { mimeType: "image/png", ext: "png", isImage: true };
  }

  // JPEG: FF D8 FF
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mimeType: "image/jpeg", ext: "jpg", isImage: true };
  }

  // GIF: GIF87a / GIF89a
  if (
    buffer.length >= 6 &&
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38 &&
    (buffer[4] === 0x37 || buffer[4] === 0x39) &&
    buffer[5] === 0x61
  ) {
    return { mimeType: "image/gif", ext: "gif", isImage: true };
  }

  // WebP: RIFF....WEBP
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return { mimeType: "image/webp", ext: "webp", isImage: true };
  }

  // BMP: BM
  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return { mimeType: "image/bmp", ext: "bmp", isImage: true };
  }

  // ICO: 00 00 01 00
  if (buffer.length >= 4 && buffer[0] === 0x00 && buffer[1] === 0x00 && buffer[2] === 0x01 && buffer[3] === 0x00) {
    return { mimeType: "image/x-icon", ext: "ico", isImage: true };
  }

  // TIFF: II*\0 or MM\0*
  if (
    buffer.length >= 4 &&
    ((buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2a && buffer[3] === 0x00) ||
      (buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00 && buffer[3] === 0x2a))
  ) {
    return { mimeType: "image/tiff", ext: "tiff", isImage: true };
  }

  // SVG XML inspection (bounded prefix check)
  const prefix = buffer.subarray(0, Math.min(buffer.length, 512)).toString("utf8").trimStart().toLowerCase();
  if (prefix.startsWith("<svg") || (prefix.startsWith("<?xml") && prefix.includes("<svg"))) {
    return { mimeType: "image/svg+xml", ext: "svg", isImage: true };
  }

  const normalizedHint = String(hintedMimeType || "").split(";")[0].trim().toLowerCase();
  if (normalizedHint && MIME_TO_EXT[normalizedHint]) {
    return {
      mimeType: normalizedHint,
      ext: MIME_TO_EXT[normalizedHint],
      isImage: normalizedHint.startsWith("image/")
    };
  }
  if (normalizedHint.startsWith("image/")) {
    const sub = normalizedHint.slice("image/".length).replace(/[^a-z0-9]/g, "") || "png";
    return { mimeType: normalizedHint, ext: sub, isImage: true };
  }

  return { mimeType: "application/octet-stream", ext: "bin", isImage: false };
}

function tryDecodeStrictBase64(raw) {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(/\s+/g, "");
  if (cleaned.length < 16 || cleaned.length % 4 !== 0) return null;
  if (!BASE64_BODY_RE.test(cleaned)) return null;
  const buffer = Buffer.from(cleaned, "base64");
  if (!buffer.length) return null;
  if (buffer.toString("base64") !== cleaned) return null;
  return buffer;
}

function sanitizeSegment(value, fallback = "tool") {
  const cleaned = String(value || fallback)
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return cleaned || fallback;
}

function isBinaryTypedValue(value) {
  return (
    Buffer.isBuffer(value) ||
    value instanceof Uint8Array ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value)
  );
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

function formatAssetPath(prefix, filename) {
  const trimmed = String(prefix || "./assets").replace(/[\\/]+$/, "");
  return `${trimmed}/${filename}`;
}

function isSingleImageWrapper(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj) || isBinaryTypedValue(obj)) return false;
  if (obj.type === "image" && typeof obj.data === "string") return { data: obj.data, mimeType: obj.mimeType || obj.mime_type || "" };
  if (obj.type === "image_url" && obj.image_url) {
    const url = typeof obj.image_url === "string" ? obj.image_url : obj.image_url.url;
    if (typeof url === "string") return { data: url, mimeType: "" };
  }
  if (obj.inlineData && typeof obj.inlineData.data === "string") {
    return { data: obj.inlineData.data, mimeType: obj.inlineData.mimeType || "" };
  }
  const keys = Object.keys(obj);
  const allowedMeta = new Set(["mimeType", "mime_type", "type", "format", "encoding"]);
  const payloadKey = keys.find((k) => ["data", "base64", "b64_json", "b64", "image", "imageData", "image_data", "bytes"].includes(k));
  if (payloadKey && (typeof obj[payloadKey] === "string" || isBinaryTypedValue(obj[payloadKey]))) {
    const otherKeys = keys.filter((k) => k !== payloadKey && !allowedMeta.has(k));
    if (otherKeys.length === 0) {
      return {
        data: obj[payloadKey],
        mimeType: obj.mimeType || obj.mime_type || (obj.format ? `image/${String(obj.format).toLowerCase()}` : "")
      };
    }
  }
  return null;
}

export function createAssetInterceptorMiddleware({
  assetsDirectory = path.resolve(process.cwd(), "assets"),
  filePathPrefix = "./assets",
  now = () => Date.now(),
  maxBinaryBytes = 25 * 1024 * 1024
} = {}) {
  const resolvedDir = path.resolve(assetsDirectory);

  async function persistAsset(buffer, { toolId = "tool", hintedMimeType = "" } = {}) {
    if (buffer.length > maxBinaryBytes) {
      throw Object.assign(new Error(`Tool asset payload exceeded the ${maxBinaryBytes} byte limit.`), {
        status: 413,
        code: "ASSET_PAYLOAD_TOO_LARGE"
      });
    }
    const format = detectBinaryFormat(buffer, hintedMimeType);
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    const timestamp = now();
    const safeTool = sanitizeSegment(toolId, "tool");
    const filename = `${safeTool}-${timestamp}-${sha256.slice(0, 8)}.${format.ext}`;
    const targetPath = path.resolve(resolvedDir, filename);
    if (!targetPath.startsWith(resolvedDir + path.sep)) {
      throw new Error("Asset output path escaped configured assets directory.");
    }

    await fs.mkdir(resolvedDir, { recursive: true });
    await fs.writeFile(targetPath, buffer);

    const filePath = formatAssetPath(filePathPrefix, filename);
    return {
      assetSaved: true,
      assetId: sha256.slice(0, 12),
      filePath,
      filename,
      mimeType: format.mimeType,
      bytes: buffer.length
    };
  }

  async function inspectAndReplace(node, { toolId, keyHint = "", mimeHint = "", savedAssets = [] }) {
    if (node === null || node === undefined) return node;

    // 1. Direct binary Buffer / Uint8Array / ArrayBuffer
    const binaryBuf = toBuffer(node);
    if (binaryBuf) {
      const ref = await persistAsset(binaryBuf, { toolId, hintedMimeType: mimeHint });
      savedAssets.push(ref);
      return ref;
    }

    // 2. String payloads (Data URIs, inline Data URIs, or raw Base64 images)
    if (typeof node === "string") {
      const exactUri = DATA_URI_EXACT_RE.exec(node.trim());
      if (exactUri) {
        const buf = tryDecodeStrictBase64(exactUri[2]);
        if (buf) {
          const ref = await persistAsset(buf, { toolId, hintedMimeType: exactUri[1] });
          savedAssets.push(ref);
          return ref;
        }
      }

      // Inline data:image/...;base64,... embedded within text/markdown
      DATA_URI_INLINE_RE.lastIndex = 0;
      if (DATA_URI_INLINE_RE.test(node)) {
        DATA_URI_INLINE_RE.lastIndex = 0;
        let rewritten = "";
        let cursor = 0;
        for (const match of node.matchAll(DATA_URI_INLINE_RE)) {
          const fullMatch = match[0];
          const matchMime = match[1];
          const matchB64 = match[2];
          if (match.index > cursor) rewritten += node.slice(cursor, match.index);
          const buf = tryDecodeStrictBase64(matchB64);
          if (buf) {
            const ref = await persistAsset(buf, { toolId, hintedMimeType: matchMime });
            savedAssets.push(ref);
            rewritten += ref.filePath;
          } else {
            rewritten += fullMatch;
          }
          cursor = match.index + fullMatch.length;
        }
        if (cursor < node.length) rewritten += node.slice(cursor);
        return rewritten;
      }

      // Raw Base64 string check
      const decoded = tryDecodeStrictBase64(node.trim());
      if (decoded) {
        const format = detectBinaryFormat(decoded, mimeHint);
        const normalizedKey = String(keyHint || "").toLowerCase();
        const hasImageKeyHint = IMAGE_HINT_KEYS.has(normalizedKey) || String(mimeHint || "").toLowerCase().startsWith("image/");
        if (format.isImage || (hasImageKeyHint && decoded.length >= 16)) {
          const ref = await persistAsset(decoded, { toolId, hintedMimeType: mimeHint || format.mimeType });
          savedAssets.push(ref);
          return ref;
        }
      }

      return node;
    }

    // 3. Arrays
    if (Array.isArray(node)) {
      const out = [];
      for (const item of node) {
        out.push(await inspectAndReplace(item, { toolId, keyHint, mimeHint: "", savedAssets }));
      }
      return out;
    }

    // 4. Plain Objects (including MCP image blocks, Gemini inlineData, OpenAI b64_json, or general maps)
    if (typeof node === "object") {
      // Avoid re-intercepting already compacted asset references
      if (node.assetSaved === true && typeof node.filePath === "string") {
        return node;
      }

      const wrapper = isSingleImageWrapper(node);
      if (wrapper) {
        const wrapperBuf = toBuffer(wrapper.data);
        if (wrapperBuf) {
          const ref = await persistAsset(wrapperBuf, { toolId, hintedMimeType: wrapper.mimeType });
          savedAssets.push(ref);
          return ref;
        }
        if (typeof wrapper.data === "string") {
          const exactUri = DATA_URI_EXACT_RE.exec(wrapper.data.trim());
          const rawB64 = exactUri ? exactUri[2] : wrapper.data;
          const inferredMime = exactUri ? exactUri[1] : wrapper.mimeType;
          const decoded = tryDecodeStrictBase64(rawB64);
          if (decoded) {
            const ref = await persistAsset(decoded, { toolId, hintedMimeType: inferredMime || "image/png" });
            savedAssets.push(ref);
            return ref;
          }
        }
      }

      const objMime = typeof node.mimeType === "string"
        ? node.mimeType
        : (typeof node.mime_type === "string" ? node.mime_type : "");

      const out = {};
      for (const [key, value] of Object.entries(node)) {
        out[key] = await inspectAndReplace(value, {
          toolId,
          keyHint: key,
          mimeHint: key === "data" || key === "base64" || key === "b64_json" || key === "image" ? objMime : "",
          savedAssets
        });
      }
      return out;
    }

    return node;
  }

  async function interceptResult(rawResult, { toolId = "tool" } = {}) {
    const savedAssets = [];
    const transformed = await inspectAndReplace(rawResult, { toolId, savedAssets });
    if (savedAssets.length === 0) {
      return rawResult;
    }

    // If the top-level result itself collapsed into a single asset reference
    if (transformed && typeof transformed === "object" && !Array.isArray(transformed) && transformed.assetSaved === true) {
      return {
        assetSaved: true,
        summary: `Saved ${transformed.mimeType} asset (${transformed.bytes} bytes) to ${transformed.filePath}`,
        filePath: transformed.filePath,
        mimeType: transformed.mimeType,
        bytes: transformed.bytes,
        assets: savedAssets
      };
    }

    // If the top-level result is an object with metadata fields, return compact object with assetSummary
    if (transformed && typeof transformed === "object" && !Array.isArray(transformed)) {
      if (!Object.prototype.hasOwnProperty.call(transformed, "assetSummary")) {
        return {
          ...transformed,
          assetSummary: {
            count: savedAssets.length,
            files: savedAssets.map((a) => ({
              assetId: a.assetId,
              filePath: a.filePath,
              mimeType: a.mimeType,
              bytes: a.bytes
            }))
          }
        };
      }
      return transformed;
    }

    // If array or text with inline data URIs replaced
    return {
      assetSaved: true,
      summary: `Saved ${savedAssets.length} asset(s) to ${filePathPrefix}/`,
      result: transformed,
      assets: savedAssets
    };
  }

  async function middleware(ctx, next) {
    const rawResult = await next();
    return interceptResult(rawResult, { toolId: ctx?.toolId || "tool" });
  }

  middleware.interceptResult = interceptResult;
  middleware.assetsDirectory = resolvedDir;
  return middleware;
}
