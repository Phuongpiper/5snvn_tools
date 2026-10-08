try { require("dotenv").config(); } catch(_) {}
const https = require("https");
const crypto = require("crypto");

const R2_ACCOUNT_ID        = process.env.R2_ACCOUNT_ID_DYLAN        || process.env.R2_ACCOUNT_ID        || "";
const R2_ACCESS_KEY_ID     = process.env.R2_ACCESS_KEY_ID_DYLAN     || process.env.R2_ACCESS_KEY_ID     || "";
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY_DYLAN || process.env.R2_SECRET_ACCESS_KEY || "";
const R2_BUCKET_NAME       = process.env.R2_BUCKET_NAME_DYLAN       || process.env.R2_BUCKET_NAME       || "";
const R2_OBJECT_KEY        = "dms_settings.json";

function hmacSha256(key, msg, enc) {
  return crypto.createHmac("sha256", key).update(msg, "utf8").digest(enc);
}
function sha256hex(msg) {
  const buf = Buffer.isBuffer(msg) ? msg : Buffer.from(String(msg || ""), "utf8");
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function buildR2Request(method, body) {
  const bodyBuf = body ? (Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8")) : Buffer.alloc(0);
  const host      = R2_ACCOUNT_ID + ".r2.cloudflarestorage.com";
  const uriPath   = "/" + R2_BUCKET_NAME + "/" + R2_OBJECT_KEY;
  const now       = new Date();
  const dateStamp = now.toISOString().slice(0, 10).replace(/-/g, "");
  const amzDate   = now.toISOString().replace(/[:-]/g, "").replace(/\.\d+/, "");
  const region    = "auto";
  const service   = "s3";

  const payloadHash  = sha256hex(bodyBuf);
  const contentType  = method === "PUT" ? "application/json; charset=utf-8" : "";

  let canonicalHeaders = "host:" + host + "\nx-amz-content-sha256:" + payloadHash + "\nx-amz-date:" + amzDate + "\n";
  let signedHeaders    = "host;x-amz-content-sha256;x-amz-date";
  if (contentType) {
    canonicalHeaders = "content-type:" + contentType + "\n" + canonicalHeaders;
    signedHeaders    = "content-type;" + signedHeaders;
  }

  const canonicalRequest = [method, uriPath, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const credentialScope  = dateStamp + "/" + region + "/" + service + "/aws4_request";
  const stringToSign     = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256hex(canonicalRequest)].join("\n");

  const kDate    = hmacSha256("AWS4" + R2_SECRET_ACCESS_KEY, dateStamp);
  const kRegion  = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  const kSigning = hmacSha256(kService, "aws4_request");
  const signature = hmacSha256(kSigning, stringToSign, "hex");

  const auth = "AWS4-HMAC-SHA256 Credential=" + R2_ACCESS_KEY_ID + "/" + credentialScope + ",SignedHeaders=" + signedHeaders + ",Signature=" + signature;

  const headers = {
    "Authorization":        auth,
    "x-amz-date":           amzDate,
    "x-amz-content-sha256": payloadHash
  };
  if (contentType) {
    headers["Content-Type"] = contentType;
    headers["Content-Length"] = bodyBuf.length;
  }
  return { host, path: uriPath, headers, bodyBuf };
}

function r2Fetch(method, body) {
  body = body || "";
  return new Promise(function(resolve, reject) {
    const info = buildR2Request(method, body);
    const options = { hostname: info.host, path: info.path, method, headers: info.headers };
    const req = https.request(options, function(res) {
      const chunks = [];
      res.on("data", function(c) { chunks.push(c); });
      res.on("end", function() {
        resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString("utf8") });
      });
    });
    req.on("error", reject);
    if (info.bodyBuf && info.bodyBuf.length > 0) req.write(info.bodyBuf);
    req.end();
  });
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
    // GET: đọc settings (hiddenTabs & excludedPhones) từ R2
    if (req.method === "GET") {
      const r2Res = await r2Fetch("GET", "");
      if (r2Res.statusCode === 404) {
        return res.status(200).json({ hiddenTabs: [], excludedPhones: [] });
      }
      if (r2Res.statusCode === 200) {
        try {
          const parsed = JSON.parse(r2Res.body);
          return res.status(200).json({
            hiddenTabs: Array.isArray(parsed.hiddenTabs) ? parsed.hiddenTabs : [],
            excludedPhones: Array.isArray(parsed.excludedPhones) ? parsed.excludedPhones : [],
            updatedAt: parsed.updatedAt || Date.now()
          });
        } catch (_) {
          return res.status(200).json({ hiddenTabs: [], excludedPhones: [] });
        }
      }
      return res.status(502).json({ error: "R2 GET failed", status: r2Res.statusCode });
    }

    // POST: lưu settings lên R2 (hỗ trợ cập nhật hiddenTabs hoặc excludedPhones)
    if (req.method === "POST") {
      let bodyData = req.body;
      if (typeof bodyData === "string") {
        try { bodyData = JSON.parse(bodyData); } catch (_) {}
      }

      // Đọc bản hiện tại từ R2 để merge tránh ghi đè mất dữ liệu khác
      let current = { hiddenTabs: [], excludedPhones: [] };
      try {
        const getR = await r2Fetch("GET", "");
        if (getR.statusCode === 200 && getR.body) {
          const parsed = JSON.parse(getR.body);
          if (parsed && typeof parsed === "object") {
            if (Array.isArray(parsed.hiddenTabs)) current.hiddenTabs = parsed.hiddenTabs;
            if (Array.isArray(parsed.excludedPhones)) current.excludedPhones = parsed.excludedPhones;
          }
        }
      } catch (_) {}

      if (bodyData && Array.isArray(bodyData.hiddenTabs)) {
        current.hiddenTabs = bodyData.hiddenTabs;
      }
      if (bodyData && Array.isArray(bodyData.excludedPhones)) {
        current.excludedPhones = bodyData.excludedPhones;
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
