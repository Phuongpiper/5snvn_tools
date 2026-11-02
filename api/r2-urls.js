try { require("dotenv").config(); } catch(_) {}

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID_DYLAN        || process.env.R2_ACCOUNT_ID        || "b63e9e1ed38dbfd59b2e77a28bb00a36";
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID_DYLAN     || process.env.R2_ACCESS_KEY_ID     || "30d0d30195468279bab5ca499ff39cf0";
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY_DYLAN || process.env.R2_SECRET_ACCESS_KEY || "7f2dc82f5e23d39b0743fbd615ce1ea964f4e182806c0c18ba81fac706c777bd";
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME_DYLAN       || process.env.R2_BUCKET_NAME       || "dylan";
const R2_OBJECT_KEY        = "system_urls.json";


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
  "Access-Control-Allow-Headers": "Content-Type"
};

module.exports = async function handler(req, res) {
  // CORS preflight
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === "OPTIONS") return res.status(204).end();

  // Debug endpoint: /api/r2-urls?debug=1
  const _parsedUrl = new URL(req.url, "http://localhost"); const urlParts0 = { query: Object.fromEntries(_parsedUrl.searchParams), pathname: _parsedUrl.pathname };
  if (urlParts0.query && urlParts0.query.debug === "1") {
    return res.status(200).json({
      R2_ACCOUNT_ID:        R2_ACCOUNT_ID        ? "✅ SET (" + R2_ACCOUNT_ID.slice(0,6) + "...)" : "❌ MISSING",
      R2_ACCESS_KEY_ID:     R2_ACCESS_KEY_ID     ? "✅ SET (" + R2_ACCESS_KEY_ID.slice(0,6) + "...)" : "❌ MISSING",
      R2_SECRET_ACCESS_KEY: R2_SECRET_ACCESS_KEY ? "✅ SET (" + R2_SECRET_ACCESS_KEY.slice(0,4) + "...)" : "❌ MISSING",
      R2_BUCKET_NAME:       R2_BUCKET_NAME       ? "✅ SET (" + R2_BUCKET_NAME + ")" : "❌ MISSING",
    });
  }

  if (req.method === "GET") {
    const _parsedUrl = new URL(req.url, "http://localhost"); const urlParts = { query: Object.fromEntries(_parsedUrl.searchParams), pathname: _parsedUrl.pathname };
    const dataParam = (req.query && req.query.data) || (urlParts.query && urlParts.query.data);
    if (dataParam) {
      try {
        const payload = JSON.parse(dataParam);
        const systemName = payload.name;
        const url = payload.url;
        if (!systemName || !url) {
          return res.status(400).json({ status: "error", message: "name and url required" });
        }

        let current = {};
        const getR = await r2Fetch("GET", "");
        if (getR.statusCode === 200) { try { current = JSON.parse(getR.body); } catch(e) {} }

        current[systemName] = url;
        const putBody = JSON.stringify(current);
        const putR = await r2Fetch("PUT", putBody);

        if (putR.statusCode >= 200 && putR.statusCode < 300) {
          return res.status(200).json({ status: "success", data: current });
        } else {
          return res.status(502).json({ status: "error", message: "R2 PUT failed HTTP " + putR.statusCode, r2Body: putR.body });
        }
      } catch (err) {
        return res.status(500).json({ status: "error", message: err.message, stack: err.stack });
      }
    } else {
      try {
        const r = await r2Fetch("GET", "");
        if (r.statusCode === 404) return res.status(200).json({});
        if (r.statusCode !== 200) return res.status(502).json({ error: "R2 GET failed", status: r.statusCode });
        if (typeof res.send === "function") return res.status(200).send(r.body);
        return res.status(200).end(r.body);
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }
  }

  if (req.method === "POST") {
    try {
      const payload = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      const { systemName, url } = payload;
      if (!systemName || !url) return res.status(400).json({ status: "error", message: "systemName and url required" });

      let current = {};
      const getR = await r2Fetch("GET", "");
      if (getR.statusCode === 200) { try { current = JSON.parse(getR.body); } catch(e) {} }

      current[systemName] = url;
      const putBody = JSON.stringify(current);
      const putR = await r2Fetch("PUT", putBody);

      if (putR.statusCode >= 200 && putR.statusCode < 300) {
        return res.status(200).json({ status: "success", data: current });
      } else {
        return res.status(502).json({ status: "error", message: "R2 PUT failed HTTP " + putR.statusCode, r2Body: putR.body });
      }
    } catch (err) {
      return res.status(500).json({ status: "error", message: err.message, stack: err.stack });
    }
  }

  return res.status(405).end("Method Not Allowed");
};
