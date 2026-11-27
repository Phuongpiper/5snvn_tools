try { require("dotenv").config(); } catch (_) {}

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID_DYLAN || process.env.R2_ACCOUNT_ID || "b63e9e1ed38dbfd59b2e77a28bb00a36";
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID_DYLAN || process.env.R2_ACCESS_KEY_ID || "30d0d30195468279bab5ca499ff39cf0";
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY_DYLAN || process.env.R2_SECRET_ACCESS_KEY || "7f2dc82f5e23d39b0743fbd615ce1ea964f4e182806c0c18ba81fac706c777bd";
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME_DYLAN || process.env.R2_BUCKET_NAME || "dylan";

const META_KEY = "task_chats/_meta.json";
const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB per file
const CACHE_TTL_MS = 25000; // 25s Worker isolate RAM cache to save >95% R2 Class B reads
const MAX_CACHED_ROOMS = 40;

function getMemCache() {
  if (!globalThis.__DMS_TASK_CHAT_CACHE__) {
    globalThis.__DMS_TASK_CHAT_CACHE__ = {
      meta: null,
      metaTs: 0,
      metaTag: "",
      rooms: new Map() // taskId -> { data, ts }
    };
  }
  return globalThis.__DMS_TASK_CHAT_CACHE__;
}

function computeMetaTag(metaObj) {
  const str = JSON.stringify(metaObj || {});
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `W/"m_${(h >>> 0).toString(16)}_${str.length}"`;
}

const MIME_BY_EXT = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  csv: "text/csv; charset=utf-8",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip",
  rar: "application/vnd.rar",
  "7z": "application/x-7z-compressed",
  txt: "text/plain; charset=utf-8",
  log: "text/plain; charset=utf-8",
  sql: "text/plain; charset=utf-8",
  json: "application/json; charset=utf-8",
  mp4: "video/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav"
};

function inferMimeType(fileName, providedMime) {
  if (providedMime && providedMime !== "application/octet-stream") return providedMime;
  const ext = String(fileName || "").split(".").pop().toLowerCase();
  return MIME_BY_EXT[ext] || providedMime || "application/octet-stream";
}

function sanitizeTaskId(id) {
  return String(id || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
}

function sanitizeFileName(name) {
  const cleaned = String(name || "file")
    .replace(/[\r\n\t\\/]+/g, "_")
    .replace(/[<>:"|?*\x00-\x1F]/g, "_")
    .trim();
  return cleaned.slice(0, 140) || "file";
}

function encodeUriPathSegments(objectKey) {
  return String(objectKey)
    .split("/")
    .map(seg => encodeURIComponent(seg))
    .join("/");
}

// ── Web Crypto AWS SigV4 helpers (Cloudflare Workers + Node 18+) ─────────────
async function sha256hex(msg) {
  const buf = typeof msg === "string" ? new TextEncoder().encode(msg) : msg;
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function hmacSha256(key, msg, outputFormat) {
  const keyBuf = typeof key === "string" ? new TextEncoder().encode(key) : key;
  const msgBuf = typeof msg === "string" ? new TextEncoder().encode(msg) : msg;
  const cryptoKey = await crypto.subtle.importKey(
    "raw", keyBuf, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, msgBuf);
  if (outputFormat === "hex") {
    return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
  }
  return new Uint8Array(sig);
}

async function s3Request(method, objectKey, bodyBytes, contentType) {
  const bodyBuf = bodyBytes
    ? (typeof bodyBytes === "string" ? new TextEncoder().encode(bodyBytes) : new Uint8Array(bodyBytes))
    : new Uint8Array(0);
  const host = R2_ACCOUNT_ID + ".r2.cloudflarestorage.com";
  const uriPath = "/" + R2_BUCKET_NAME + "/" + encodeUriPathSegments(objectKey);
  const now = new Date();
  const dateStamp = now.toISOString().slice(0, 10).replace(/-/g, "");
  const amzDate = now.toISOString().replace(/[:-]/g, "").replace(/\.\d+/, "");
  const region = "auto";
  const service = "s3";

  const payloadHash = await sha256hex(bodyBuf);
  const ct = method === "PUT" ? (contentType || "application/octet-stream") : "";

  let canonicalHeaders = "host:" + host + "\nx-amz-content-sha256:" + payloadHash + "\nx-amz-date:" + amzDate + "\n";
  let signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  if (ct) {
    canonicalHeaders = "content-type:" + ct + "\n" + canonicalHeaders;
    signedHeaders = "content-type;" + signedHeaders;
  }

  const canonicalRequest = [method, uriPath, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const credentialScope = dateStamp + "/" + region + "/" + service + "/aws4_request";
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, await sha256hex(canonicalRequest)].join("\n");

  const kDate = await hmacSha256("AWS4" + R2_SECRET_ACCESS_KEY, dateStamp);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  const kSigning = await hmacSha256(kService, "aws4_request");
  const signature = await hmacSha256(kSigning, stringToSign, "hex");

  const auth = "AWS4-HMAC-SHA256 Credential=" + R2_ACCESS_KEY_ID + "/" + credentialScope + ",SignedHeaders=" + signedHeaders + ",Signature=" + signature;

  const headers = {
    "Authorization": auth,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": payloadHash
  };
  if (ct) {
    headers["Content-Type"] = ct;
  }

  return fetch("https://" + host + uriPath, {
    method,
    headers,
    body: method === "PUT" ? bodyBuf : undefined
  });
}

// ── Unified R2 helpers (prefers native Worker R2 binding `env.DYLAN` if present) ──
async function r2GetJson(env, key, fallback) {
  try {
    if (env && env.DYLAN && typeof env.DYLAN.get === "function") {
      const obj = await env.DYLAN.get(key);
      if (!obj) return { data: fallback, etag: "" };
      const text = await obj.text();
      return { data: JSON.parse(text), etag: obj.httpEtag || obj.etag || "" };
    }
    const resp = await s3Request("GET", key);
    if (resp.status !== 200) return { data: fallback, etag: "" };
    const text = await resp.text();
    return { data: JSON.parse(text), etag: resp.headers.get("etag") || "" };
  } catch (_) {
    return { data: fallback, etag: "" };
  }
}

async function r2PutJson(env, key, data) {
  const jsonStr = JSON.stringify(data);
  if (env && env.DYLAN && typeof env.DYLAN.put === "function") {
    await env.DYLAN.put(key, jsonStr, {
      httpMetadata: { contentType: "application/json; charset=utf-8" }
    });
    return true;
  }
  const resp = await s3Request("PUT", key, jsonStr, "application/json; charset=utf-8");
  return resp.status >= 200 && resp.status < 300;
}

async function r2PutBinary(env, key, bytes, contentType) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (env && env.DYLAN && typeof env.DYLAN.put === "function") {
    await env.DYLAN.put(key, u8, {
      httpMetadata: { contentType: contentType || "application/octet-stream" }
    });
    return true;
  }
  const resp = await s3Request("PUT", key, u8, contentType || "application/octet-stream");
  return resp.status >= 200 && resp.status < 300;
}

async function r2GetBinary(env, key) {
  if (env && env.DYLAN && typeof env.DYLAN.get === "function") {
    const obj = await env.DYLAN.get(key);
    if (!obj) return null;
    const ab = await obj.arrayBuffer();
    const ct = (obj.httpMetadata && obj.httpMetadata.contentType) || "";
    return { bytes: new Uint8Array(ab), contentType: ct, etag: obj.httpEtag || "" };
  }
  const resp = await s3Request("GET", key);
  if (resp.status !== 200) return null;
  const ab = await resp.arrayBuffer();
  return {
    bytes: new Uint8Array(ab),
    contentType: resp.headers.get("content-type") || "",
    etag: resp.headers.get("etag") || ""
  };
}

async function r2DeleteKey(env, key) {
  try {
    if (env && env.DYLAN && typeof env.DYLAN.delete === "function") {
      await env.DYLAN.delete(key);
      return;
    }
    await s3Request("DELETE", key);
  } catch (_) {}
}

async function getCachedMeta(env) {
  const cache = getMemCache();
  const now = Date.now();
  if (cache.meta && (now - cache.metaTs < CACHE_TTL_MS)) {
    return { meta: cache.meta, etag: cache.metaTag };
  }
  const { data } = await r2GetJson(env, META_KEY, {});
  const safeMeta = (data && typeof data === "object") ? data : {};
  cache.meta = safeMeta;
  cache.metaTs = now;
  cache.metaTag = computeMetaTag(safeMeta);
  return { meta: safeMeta, etag: cache.metaTag };
}

async function saveMetaThroughCache(env, nextMeta) {
  const cache = getMemCache();
  cache.meta = nextMeta;
  cache.metaTs = Date.now();
  cache.metaTag = computeMetaTag(nextMeta);
  await r2PutJson(env, META_KEY, nextMeta);
}

async function getCachedRoom(env, taskId) {
  const cache = getMemCache();
  const now = Date.now();
  const hit = cache.rooms.get(taskId);
  if (hit && (now - hit.ts < CACHE_TTL_MS)) {
    return hit.data;
  }
  const roomKey = `task_chats/room_${taskId}.json`;
  const { data } = await r2GetJson(env, roomKey, { taskId, updatedAt: 0, messages: [] });
  const safeRoom = (data && typeof data === "object") ? data : { taskId, updatedAt: 0, messages: [] };
  if (!Array.isArray(safeRoom.messages)) safeRoom.messages = [];
  if (cache.rooms.size >= MAX_CACHED_ROOMS) {
    const oldestKey = cache.rooms.keys().next().value;
    if (oldestKey) cache.rooms.delete(oldestKey);
  }
  cache.rooms.set(taskId, { data: safeRoom, ts: now });
  return safeRoom;
}

async function saveRoomThroughCache(env, taskId, room) {
  const cache = getMemCache();
  cache.rooms.set(taskId, { data: room, ts: Date.now() });
  const roomKey = `task_chats/room_${taskId}.json`;
  await r2PutJson(env, roomKey, room);
}

function buildMessagePreview(msg) {
  if (!msg || msg.deleted) return "Tin nhắn đã thu hồi";
  if (msg.text && msg.text.trim()) {
    return msg.text.trim().replace(/\s+/g, " ").slice(0, 90);
  }
  if (msg.tableData && Array.isArray(msg.tableData.rows)) {
    return `📊 Bảng dữ liệu (${msg.tableData.rows.length} dòng)`;
  }
  if (Array.isArray(msg.attachments) && msg.attachments.length > 0) {
    const imgs = msg.attachments.filter(a => a.isImage).length;
    const files = msg.attachments.length - imgs;
    if (imgs > 0 && files === 0) return `🖼 Đã gửi ${imgs} hình ảnh`;
    if (files > 0 && imgs === 0) return `📎 Đã gửi tệp: ${msg.attachments[0].name}`;
    return `📎 Đã gửi ${msg.attachments.length} tệp đính kèm`;
  }
  return "Tin nhắn mới";
}

function computeRoomMetaSummary(room) {
  const msgs = Array.isArray(room.messages) ? room.messages : [];
  const activeMsgs = msgs.filter(m => !m.deleted);
  const pinnedCount = activeMsgs.filter(m => m.pinned).length;
  const lastMsg = activeMsgs.length > 0 ? activeMsgs[activeMsgs.length - 1] : (msgs[msgs.length - 1] || null);

  if (!lastMsg) {
    return {
      count: 0,
      pinnedCount: 0,
      lastMsgId: "",
      lastAt: room.updatedAt || 0,
      lastSenderName: "",
      lastSenderCode: "",
      lastPreview: "",
      lastMentions: [],
      recent: []
    };
  }

  const recent = activeMsgs.slice(-50).map(m => [
    Number(m.createdAt || 0),
    String(m.senderName || ""),
    String(m.senderCode || "")
  ]);

  return {
    count: activeMsgs.length,
    pinnedCount,
    lastMsgId: lastMsg.id || "",
    lastAt: lastMsg.createdAt || room.updatedAt || Date.now(),
    lastSenderName: lastMsg.senderName || "",
    lastSenderCode: lastMsg.senderCode || "",
    lastPreview: buildMessagePreview(lastMsg),
    lastMentions: Array.isArray(lastMsg.mentions) ? lastMsg.mentions : [],
    recent
  };
}

function decodeBase64ToUint8(b64) {
  const clean = String(b64 || "").replace(/^data:[^;]+;base64,/, "");
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(clean, "base64"));
  }
  const bin = atob(clean);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,HEAD,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, If-None-Match, Cache-Control, Pragma, X-Requested-With");
  res.setHeader("Access-Control-Expose-Headers", "ETag, Last-Modified, Content-Disposition");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  const env = req.env || null;
  const parsedUrl = new URL(req.url, "http://localhost");
  const query = Object.fromEntries(parsedUrl.searchParams);
  const action = query.action || "";

  try {
    // ── 1. SERVE BINARY ATTACHMENT (IMAGE / FILE) ────────────────────────────
    if (req.method === "GET" && action === "file") {
      const key = String(query.key || "").trim();
      if (!key.startsWith("task_chat_files/") || key.includes("..")) {
        return res.status(400).json({ status: "error", message: "Key tệp không hợp lệ" });
      }
      const fileObj = await r2GetBinary(env, key);
      if (!fileObj) {
        return res.status(404).json({ status: "error", message: "Không tìm thấy tệp trên Cloud R2" });
      }
      const rawName = sanitizeFileName(query.name || key.split("/").pop() || "file");
      const mime = inferMimeType(rawName, fileObj.contentType);
      const isDownload = query.download === "1" || query.download === "true";
      const dispType = isDownload ? "attachment" : "inline";
      const asciiFallback = rawName.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "");

      res.setHeader("Content-Type", mime);
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.setHeader(
        "Content-Disposition",
        `${dispType}; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(rawName)}`
      );
      if (fileObj.etag) res.setHeader("ETag", fileObj.etag);

      const outBody = (typeof Buffer !== "undefined" && !req.isWorkerAdapter)
        ? Buffer.from(fileObj.bytes)
        : fileObj.bytes;
      return res.status(200).end(outBody);
    }

    // Non-file responses must not be cached
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");

    // ── 2. GET / HEAD META SUMMARY OF ALL CHAT ROOMS ─────────────────────────
    if ((req.method === "GET" || req.method === "HEAD") && (action === "meta" || !action)) {
      const { meta, etag } = await getCachedMeta(env);
      if (etag) res.setHeader("ETag", etag);
      const clientTag = (req.headers && req.headers["if-none-match"]) || query.v || "";
      if (clientTag && etag && clientTag === etag) {
        return res.status(304).end();
      }
      if (req.method === "HEAD") {
        return res.status(200).end();
      }
      return res.status(200).json({ status: "success", version: etag, meta: meta || {} });
    }

    // ── 3. GET MESSAGES FOR A SPECIFIC TASK ROOM ─────────────────────────────
    if (req.method === "GET" && action === "messages") {
      const taskId = sanitizeTaskId(query.taskId);
      if (!taskId) {
        return res.status(400).json({ status: "error", message: "Thiếu taskId" });
      }
      const room = await getCachedRoom(env, taskId);
      const roomUpdatedAt = Number(room.updatedAt || 0);
      const roomTag = `W/"r_${taskId}_${roomUpdatedAt}_${(room.messages || []).length}"`;
      res.setHeader("ETag", roomTag);

      const sinceTs = Number(query.since || 0);
      const clientIfNone = (req.headers && req.headers["if-none-match"]) || "";
      if ((sinceTs > 0 && roomUpdatedAt > 0 && sinceTs === roomUpdatedAt) || (clientIfNone && clientIfNone === roomTag)) {
        return res.status(304).end();
      }

      return res.status(200).json({
        status: "success",
        taskId,
        updatedAt: roomUpdatedAt,
        messages: Array.isArray(room.messages) ? room.messages : []
      });
    }

    // ── 4. POST UPLOAD BINARY FILE / IMAGE ───────────────────────────────────
    if (req.method === "POST" && action === "upload_file") {
      const taskId = sanitizeTaskId(query.taskId || (req.body && req.body.taskId));
      if (!taskId) {
        return res.status(400).json({ status: "error", message: "Thiếu taskId khi tải tệp lên" });
      }

      let rawBytes = null;
      let origName = query.name || "";
      let mimeType = query.type || "";

      if (req.rawBytes && req.rawBytes.length > 0 && !(req.headers && String(req.headers["content-type"] || "").includes("application/json"))) {
        rawBytes = req.rawBytes instanceof Uint8Array ? req.rawBytes : new Uint8Array(req.rawBytes);
      } else {
        const payload = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
        origName = origName || payload.name || "file";
        mimeType = mimeType || payload.mimeType || "";
        if (payload.base64) {
          rawBytes = decodeBase64ToUint8(payload.base64);
        }
      }

      if (!rawBytes || rawBytes.length === 0) {
        return res.status(400).json({ status: "error", message: "Dữ liệu tệp trống" });
      }
      if (rawBytes.length > MAX_FILE_BYTES) {
        return res.status(413).json({ status: "error", message: "Tệp vượt quá giới hạn 25MB" });
      }

      const safeName = sanitizeFileName(origName || "attachment");
      const finalMime = inferMimeType(safeName, mimeType);
      const nowTs = Date.now();
      const rand = Math.random().toString(36).slice(2, 8);
      const fileId = `f_${nowTs}_${rand}`;
      const r2Key = `task_chat_files/${taskId}/${nowTs}_${rand}_${safeName}`;

      const ok = await r2PutBinary(env, r2Key, rawBytes, finalMime);
      if (!ok) {
        return res.status(502).json({ status: "error", message: "Lưu tệp lên Cloud R2 thất bại" });
      }

      const isImage = /^image\/(png|jpe?g|gif|webp|bmp|svg\+xml)$/i.test(finalMime);
      return res.status(200).json({
        status: "success",
        attachment: {
          id: fileId,
          key: r2Key,
          name: safeName,
          mimeType: finalMime,
          size: rawBytes.length,
          isImage
        }
      });
    }

    // ── 5. POST CHAT MESSAGE ACTIONS (JSON) ──────────────────────────────────
    if (req.method === "POST") {
      const payload = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
      const bodyAction = payload.action || action;
      const taskId = sanitizeTaskId(payload.taskId || query.taskId);

      if (!taskId) {
        return res.status(400).json({ status: "error", message: "Thiếu taskId" });
      }

      const room = await getCachedRoom(env, taskId);
      if (!Array.isArray(room.messages)) room.messages = [];

      if (bodyAction === "send_message") {
        const senderName = String(payload.senderName || "").trim();
        const senderCode = String(payload.senderCode || "").trim().toUpperCase();
        const text = String(payload.text || "").trim();
        const attachments = Array.isArray(payload.attachments) ? payload.attachments.slice(0, 20) : [];
        const tableData = (payload.tableData && Array.isArray(payload.tableData.rows) && payload.tableData.rows.length > 0)
          ? {
              headers: Array.isArray(payload.tableData.headers) ? payload.tableData.headers : [],
              rows: payload.tableData.rows.slice(0, 500),
              tsv: String(payload.tableData.tsv || "").slice(0, 200000)
            }
          : null;

        if (!senderName) {
          return res.status(400).json({ status: "error", message: "Vui lòng chọn nhân viên trước khi gửi tin nhắn" });
        }
        if (!text && attachments.length === 0 && !tableData) {
          return res.status(400).json({ status: "error", message: "Nội dung tin nhắn trống" });
        }

        const nowTs = Date.now();
        const rand = Math.random().toString(36).slice(2, 7);
        const newMsg = {
          id: `m_${nowTs}_${rand}`,
          taskId,
          senderName,
          senderCode,
          text,
          tableData,
          attachments: attachments.map(a => ({
            id: String(a.id || `f_${nowTs}`),
            key: String(a.key || ""),
            name: sanitizeFileName(a.name || "file"),
            mimeType: String(a.mimeType || "application/octet-stream"),
            size: Number(a.size) || 0,
            isImage: Boolean(a.isImage)
          })).filter(a => a.key.startsWith("task_chat_files/")),
          mentions: Array.isArray(payload.mentions) ? payload.mentions.map(x => String(x).trim()).filter(Boolean) : [],
          replyTo: payload.replyTo && payload.replyTo.id ? {
            id: String(payload.replyTo.id),
            senderName: String(payload.replyTo.senderName || ""),
            preview: String(payload.replyTo.preview || "").slice(0, 140)
          } : null,
          reactions: {},
          pinned: false,
          pinnedBy: "",
          editedAt: null,
          deleted: false,
          createdAt: nowTs
        };

        room.messages.push(newMsg);
        room.updatedAt = nowTs;

        const { meta } = await getCachedMeta(env);
        const nextMeta = Object.assign({}, meta || {});
        nextMeta[taskId] = computeRoomMetaSummary(room);

        await Promise.all([
          saveRoomThroughCache(env, taskId, room),
          saveMetaThroughCache(env, nextMeta)
        ]);

        return res.status(200).json({
          status: "success",
          message: newMsg,
          roomSummary: nextMeta[taskId],
          updatedAt: room.updatedAt
        });
      }

      if (bodyAction === "edit_message") {
        const msgId = String(payload.msgId || "");
        const newText = String(payload.text || "").trim();
        const msg = room.messages.find(m => m.id === msgId);
        if (!msg || msg.deleted) {
          return res.status(404).json({ status: "error", message: "Không tìm thấy tin nhắn" });
        }
        if (!newText && (!msg.attachments || !msg.attachments.length) && !msg.tableData) {
          return res.status(400).json({ status: "error", message: "Nội dung không được để trống" });
        }
        msg.text = newText;
        if (Array.isArray(payload.mentions)) {
          msg.mentions = payload.mentions.map(x => String(x).trim()).filter(Boolean);
        }
        msg.editedAt = Date.now();
        room.updatedAt = msg.editedAt;

        const { meta } = await getCachedMeta(env);
        const nextMeta = Object.assign({}, meta || {});
        nextMeta[taskId] = computeRoomMetaSummary(room);

        await Promise.all([
          saveRoomThroughCache(env, taskId, room),
          saveMetaThroughCache(env, nextMeta)
        ]);

        return res.status(200).json({ status: "success", message: msg, roomSummary: nextMeta[taskId] });
      }

      if (bodyAction === "delete_message") {
        const msgId = String(payload.msgId || "");
        const msg = room.messages.find(m => m.id === msgId);
        if (!msg) {
          return res.status(404).json({ status: "error", message: "Không tìm thấy tin nhắn" });
        }
        const oldAttachments = Array.isArray(msg.attachments) ? [...msg.attachments] : [];
        msg.deleted = true;
        msg.text = "";
        msg.tableData = null;
        msg.attachments = [];
        msg.pinned = false;
        msg.editedAt = Date.now();
        room.updatedAt = msg.editedAt;

        const { meta } = await getCachedMeta(env);
        const nextMeta = Object.assign({}, meta || {});
        nextMeta[taskId] = computeRoomMetaSummary(room);

        await Promise.all([
          saveRoomThroughCache(env, taskId, room),
          saveMetaThroughCache(env, nextMeta),
          ...oldAttachments.map(a => a.key ? r2DeleteKey(env, a.key) : Promise.resolve())
        ]);

        return res.status(200).json({ status: "success", msgId, roomSummary: nextMeta[taskId] });
      }

      if (bodyAction === "toggle_reaction") {
        const msgId = String(payload.msgId || "");
        const emoji = String(payload.emoji || "").trim().slice(0, 8);
        const memberName = String(payload.memberName || "").trim();
        const msg = room.messages.find(m => m.id === msgId);
        if (!msg || msg.deleted || !emoji || !memberName) {
          return res.status(400).json({ status: "error", message: "Dữ liệu thả cảm xúc không hợp lệ" });
        }
        if (!msg.reactions || typeof msg.reactions !== "object") msg.reactions = {};
        if (!Array.isArray(msg.reactions[emoji])) msg.reactions[emoji] = [];

        const existingIdx = msg.reactions[emoji].findIndex(n => n.toLowerCase() === memberName.toLowerCase());
        if (existingIdx >= 0) {
          msg.reactions[emoji].splice(existingIdx, 1);
          if (msg.reactions[emoji].length === 0) delete msg.reactions[emoji];
        } else {
          msg.reactions[emoji].push(memberName);
        }
        room.updatedAt = Date.now();
        await saveRoomThroughCache(env, taskId, room);
        return res.status(200).json({ status: "success", msgId, reactions: msg.reactions, updatedAt: room.updatedAt });
      }

      if (bodyAction === "toggle_pin") {
        const msgId = String(payload.msgId || "");
        const memberName = String(payload.memberName || "").trim();
        const msg = room.messages.find(m => m.id === msgId);
        if (!msg || msg.deleted) {
          return res.status(404).json({ status: "error", message: "Không tìm thấy tin nhắn" });
        }
        msg.pinned = !msg.pinned;
        msg.pinnedBy = msg.pinned ? memberName : "";
        room.updatedAt = Date.now();

        const { meta } = await getCachedMeta(env);
        const nextMeta = Object.assign({}, meta || {});
        nextMeta[taskId] = computeRoomMetaSummary(room);

        await Promise.all([
          saveRoomThroughCache(env, taskId, room),
          saveMetaThroughCache(env, nextMeta)
        ]);

        return res.status(200).json({ status: "success", msgId, pinned: msg.pinned, pinnedBy: msg.pinnedBy, roomSummary: nextMeta[taskId] });
      }

      return res.status(400).json({ status: "error", message: "Action không hợp lệ: " + bodyAction });
    }

    return res.status(405).json({ status: "error", message: "Method Not Allowed" });
  } catch (err) {
    return res.status(500).json({ status: "error", message: err.message });
  }
};
