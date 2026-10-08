try { require("dotenv").config(); } catch(_) {}
const https = require("https");
const crypto = require("crypto");

const R2_ACCOUNT_ID        = process.env.R2_ACCOUNT_ID_DYLAN        || process.env.R2_ACCOUNT_ID        || "";
const R2_ACCESS_KEY_ID     = process.env.R2_ACCESS_KEY_ID_DYLAN     || process.env.R2_ACCESS_KEY_ID     || "";
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY_DYLAN || process.env.R2_SECRET_ACCESS_KEY || "";
const R2_BUCKET_NAME       = process.env.R2_BUCKET_NAME_DYLAN       || process.env.R2_BUCKET_NAME       || "";
const R2_OBJECT_KEY        = "system_urls.json";

function hmacSha256(key, msg, enc) {
  return crypto.createHmac("sha256", key).update(msg, "utf8").digest(enc);
}
function sha256hex(msg) {
  return crypto.createHash("sha256").update(msg, "utf8").digest("hex");
}

function buildR2Request(method, body) {
  body = body || "";
  const host      = R2_ACCOUNT_ID + ".r2.cloudflarestorage.com";
  const uriPath   = "/" + R2_BUCKET_NAME + "/" + R2_OBJECT_KEY;
  const now       = new Date();
  const dateStamp = now.toISOString().slice(0, 10).replace(/-/g, "");
  const amzDate   = now.toISOString().replace(/[:-]/g, "").replace(/\.\d+/, "");
  const region    = "auto";
  const service   = "s3";

  const payloadHash  = sha256hex(body);
  const contentType  = method === "PUT" ? "application/json" : "";

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
  if (contentType) headers["Content-Type"] = contentType;
  return { host: host, path: uriPath, headers: headers };
}

function r2Fetch(method, body) {
  body = body || "";
  return new Promise(function(resolve, reject) {
    const info = buildR2Request(method, body);
    const options = { hostname: info.host, path: info.path, method: method, headers: info.headers };
    const req = https.request(options, function(res) {
      let data = "";
      res.on("data", function(c) { data += c; });
      res.on("end", function() { resolve({ statusCode: res.statusCode, body: data }); });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
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
  const urlParts0 = require("url").parse(req.url, true);
  if (urlParts0.query && urlParts0.query.debug === "1") {
    return res.status(200).json({
      R2_ACCOUNT_ID:        R2_ACCOUNT_ID        ? "✅ SET (" + R2_ACCOUNT_ID.slice(0,6) + "...)" : "❌ MISSING",
      R2_ACCESS_KEY_ID:     R2_ACCESS_KEY_ID     ? "✅ SET (" + R2_ACCESS_KEY_ID.slice(0,6) + "...)" : "❌ MISSING",
      R2_SECRET_ACCESS_KEY: R2_SECRET_ACCESS_KEY ? "✅ SET (" + R2_SECRET_ACCESS_KEY.slice(0,4) + "...)" : "❌ MISSING",
      R2_BUCKET_NAME:       R2_BUCKET_NAME       ? "✅ SET (" + R2_BUCKET_NAME + ")" : "❌ MISSING",
    });
  }

  if (req.method === "GET") {
    const urlParts = require("url").parse(req.url, true);
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
