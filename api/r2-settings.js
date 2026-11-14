try { require("dotenv").config(); } catch(_) {}

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID_DYLAN        || process.env.R2_ACCOUNT_ID        || "b63e9e1ed38dbfd59b2e77a28bb00a36";
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID_DYLAN     || process.env.R2_ACCESS_KEY_ID     || "30d0d30195468279bab5ca499ff39cf0";
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY_DYLAN || process.env.R2_SECRET_ACCESS_KEY || "7f2dc82f5e23d39b0743fbd615ce1ea964f4e182806c0c18ba81fac706c777bd";
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME_DYLAN       || process.env.R2_BUCKET_NAME       || "dylan";
const R2_OBJECT_KEY        = "dms_settings.json";


// ── Web Crypto helpers (works in Cloudflare Workers + Node 18+) ───────────────
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

async function r2Fetch(method, body, objectKey) {
  if (objectKey === undefined) objectKey = R2_OBJECT_KEY;
  body = body || "";
  const bodyBuf = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const host    = R2_ACCOUNT_ID + ".r2.cloudflarestorage.com";
  const uriPath = "/" + R2_BUCKET_NAME + "/" + objectKey;
  const now       = new Date();
  const dateStamp = now.toISOString().slice(0, 10).replace(/-/g, "");
  const amzDate   = now.toISOString().replace(/[:-]/g, "").replace(/\.\d+/, "");
  const region    = "auto";
  const service   = "s3";

  const payloadHash = await sha256hex(bodyBuf);
  const contentType = method === "PUT" ? "application/json; charset=utf-8" : "";

  let canonicalHeaders = "host:" + host + "\nx-amz-content-sha256:" + payloadHash + "\nx-amz-date:" + amzDate + "\n";
  let signedHeaders    = "host;x-amz-content-sha256;x-amz-date";
  if (contentType) {
    canonicalHeaders = "content-type:" + contentType + "\n" + canonicalHeaders;
    signedHeaders    = "content-type;" + signedHeaders;
  }

  const canonicalRequest = [method, uriPath, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const credentialScope  = dateStamp + "/" + region + "/" + service + "/aws4_request";
  const stringToSign     = ["AWS4-HMAC-SHA256", amzDate, credentialScope, await sha256hex(canonicalRequest)].join("\n");

  const kDate    = await hmacSha256("AWS4" + R2_SECRET_ACCESS_KEY, dateStamp);
  const kRegion  = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  const kSigning = await hmacSha256(kService, "aws4_request");
  const signature = await hmacSha256(kSigning, stringToSign, "hex");

  const auth = "AWS4-HMAC-SHA256 Credential=" + R2_ACCESS_KEY_ID + "/" + credentialScope + ",SignedHeaders=" + signedHeaders + ",Signature=" + signature;

  const headers = {
    "Authorization":        auth,
    "x-amz-date":           amzDate,
    "x-amz-content-sha256": payloadHash
  };
  if (contentType) {
    headers["Content-Type"] = contentType;
    headers["Content-Length"] = String(bodyBuf.length);
  }

  const resp = await fetch("https://" + host + uriPath, {
    method: method,
    headers: headers,
    body: method === "PUT" ? bodyBuf : undefined
  });
  const resBody = await resp.text();
  return { statusCode: resp.status, body: resBody, headers: Object.fromEntries(resp.headers.entries()) };
}


const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Pragma, Cache-Control, X-Requested-With",
  "Access-Control-Allow-Private-Network": "true"
};

module.exports = async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === "OPTIONS") return res.status(204).end();

  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");

  try {
    // GET: đọc settings (hiddenTabs, excludedPhones, projectDids) từ R2
    if (req.method === "GET") {
      const r2Res = await r2Fetch("GET", "");
      if (r2Res.statusCode === 404) {
        return res.status(200).json({ hiddenTabs: [], excludedPhones: [], projectDids: null, setupProjects: [] });
      }
      if (r2Res.statusCode === 200) {
        try {
          const parsed = JSON.parse(r2Res.body);
          return res.status(200).json({
            hiddenTabs: Array.isArray(parsed.hiddenTabs) ? parsed.hiddenTabs : [],
            excludedPhones: Array.isArray(parsed.excludedPhones) ? parsed.excludedPhones : [],
            projectDids: (parsed && typeof parsed.projectDids === "object") ? parsed.projectDids : null,
            setupProjects: Array.isArray(parsed.setupProjects) ? parsed.setupProjects : [],
            updatedAt: parsed.updatedAt || Date.now()
          });
        } catch (_) {
          return res.status(200).json({ hiddenTabs: [], excludedPhones: [], projectDids: null, setupProjects: [] });
        }
      }
      return res.status(502).json({ error: "R2 GET failed", status: r2Res.statusCode });
    }

    // POST: lưu settings lên R2 (hỗ trợ cập nhật hiddenTabs, excludedPhones, projectDids hoặc setupProjects)
    if (req.method === "POST") {
      let bodyData = req.body;
      if (typeof bodyData === "string") {
        try { bodyData = JSON.parse(bodyData); } catch (_) {}
      }

      // Đọc bản hiện tại từ R2 để merge tránh ghi đè mất dữ liệu khác
      let current = { hiddenTabs: [], excludedPhones: [], projectDids: null, setupProjects: [] };
      try {
        const getR = await r2Fetch("GET", "");
        if (getR.statusCode === 200 && getR.body) {
          const parsed = JSON.parse(getR.body);
          if (parsed && typeof parsed === "object") {
            if (Array.isArray(parsed.hiddenTabs)) current.hiddenTabs = parsed.hiddenTabs;
            if (Array.isArray(parsed.excludedPhones)) current.excludedPhones = parsed.excludedPhones;
            if (parsed.projectDids && typeof parsed.projectDids === "object") current.projectDids = parsed.projectDids;
            if (Array.isArray(parsed.setupProjects)) current.setupProjects = parsed.setupProjects;
          }
        }
      } catch (_) {}

      if (bodyData && Array.isArray(bodyData.hiddenTabs)) {
        current.hiddenTabs = bodyData.hiddenTabs;
      }
      if (bodyData && Array.isArray(bodyData.excludedPhones)) {
        current.excludedPhones = bodyData.excludedPhones;
      }
      if (bodyData && bodyData.projectDids !== undefined) {
        current.projectDids = bodyData.projectDids;
      }
      if (bodyData && Array.isArray(bodyData.setupProjects)) {
        current.setupProjects = bodyData.setupProjects;
      }
      current.updatedAt = Date.now();

      const putR = await r2Fetch("PUT", JSON.stringify(current));
      if (putR.statusCode >= 200 && putR.statusCode < 300) {
        return res.status(200).json({ status: "success", ...current });
      }
      return res.status(502).json({ error: "R2 PUT failed", status: putR.statusCode });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
