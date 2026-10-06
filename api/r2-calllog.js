try { require("dotenv").config(); } catch(_) {}
const https = require("https");
const crypto = require("crypto");

const R2_ACCOUNT_ID        = process.env.R2_ACCOUNT_ID_DYLAN        || process.env.R2_ACCOUNT_ID        || "";
const R2_ACCESS_KEY_ID     = process.env.R2_ACCESS_KEY_ID_DYLAN     || process.env.R2_ACCESS_KEY_ID     || "";
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY_DYLAN || process.env.R2_SECRET_ACCESS_KEY || "";
const R2_BUCKET_NAME       = process.env.R2_BUCKET_NAME_DYLAN       || process.env.R2_BUCKET_NAME       || "";
const R2_OBJECT_KEY        = "dms_call_log.json";

function hmacSha256(key, msg, enc) {
  return crypto.createHmac("sha256", key).update(msg, "utf8").digest(enc);
}
function sha256hex(msg) {
  const buf = Buffer.isBuffer(msg) ? msg : Buffer.from(String(msg || ""), "utf8");
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function extractUserCodeFromDetails(cd) {
  const text = String(cd || "").trim();
  if (!text) return "";
  const m = text.match(/_([^_]+)_Hotline/i);
  if (m && !/^NPP\s/i.test(m[1]) && !/^Ticket/i.test(m[1])) {
    return m[1].trim();
  }
  const fb = text.match(/_(HQ\s+[^_]+|\d+[A-Z]\d+|ADMIN|ASM|SUP)(?:_|$)/i);
  return fb ? fb[1].trim() : "";
}

function sanitizeRowUserCode(r) {
  if (!r || typeof r !== "object") return r;
  const cd = String(r["Call Details"] || r["call details"] || "").trim();
  const extracted = extractUserCodeFromDetails(cd);
  if (extracted) {
    r["User code"] = extracted;
    r["User Code"] = extracted;
  }
  return r;
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
  return { host: host, path: uriPath, headers: headers, bodyBuf: bodyBuf };
}

function r2Fetch(method, body) {
  body = body || "";
  return new Promise(function(resolve, reject) {
    const info = buildR2Request(method, body);
    const options = { hostname: info.host, path: info.path, method: method, headers: info.headers };
    const req = https.request(options, function(res) {
      const chunks = [];
      res.on("data", function(c) { chunks.push(c); });
      res.on("end", function() {
        const fullBody = Buffer.concat(chunks).toString("utf8");
        resolve({ statusCode: res.statusCode, body: fullBody, headers: res.headers });
      });
    });
    req.on("error", reject);
    if (info.bodyBuf && info.bodyBuf.length > 0) {
      req.write(info.bodyBuf);
    }
    req.end();
  });
}

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET,POST,HEAD,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Expose-Headers": "ETag, Last-Modified"
};

module.exports = async function handler(req, res) {
  // CORS preflight
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === "OPTIONS") return res.status(204).end();

  // Force no-cache for real-time synchronization
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");

  try {
    if (req.method === "HEAD") {
      const r2Res = await r2Fetch("HEAD", "");
      if (r2Res.headers) {
        const etag = r2Res.headers["etag"] || r2Res.headers["ETag"] || "";
        const lm = r2Res.headers["last-modified"] || r2Res.headers["Last-Modified"] || "";
        if (etag) res.setHeader("ETag", etag);
        if (lm) res.setHeader("Last-Modified", lm);
      }
      return res.status(r2Res.statusCode === 200 ? 200 : (r2Res.statusCode === 404 ? 404 : 502)).end();
    }

    if (req.method === "GET") {
      const r2Res = await r2Fetch("GET", "");
      if (r2Res.headers) {
        const etag = r2Res.headers["etag"] || r2Res.headers["ETag"] || "";
        const lm = r2Res.headers["last-modified"] || r2Res.headers["Last-Modified"] || "";
        if (etag) res.setHeader("ETag", etag);
        if (lm) res.setHeader("Last-Modified", lm);
      }

      if (r2Res.statusCode === 404) {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        return res.status(200).json({ status: "not_found", rows: [] });
      }

      if (r2Res.statusCode === 200) {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        try {
          const parsed = JSON.parse(r2Res.body);
          if (parsed && Array.isArray(parsed.rows)) {
            parsed.rows = parsed.rows.map(sanitizeRowUserCode);
          }
          return res.status(200).json(parsed);
        } catch (_) {
          return res.status(200).send(r2Res.body);
        }
      }

      return res.status(502).json({ error: "R2 GET failed", status: r2Res.statusCode });
    }

    if (req.method === "POST") {
      let bodyData = req.body;
      if (typeof bodyData === "string") {
        try { bodyData = JSON.parse(bodyData); } catch (_) {}
      }

      if (!bodyData || (typeof bodyData !== "object")) {
        return res.status(400).json({ error: "Invalid body data" });
      }

      // Hỗ trợ action: append_row hoặc append_issue để thêm 1 dòng mới vào Call Log mà không ghi đè
      if (bodyData.action === "append_row" || bodyData.action === "append_issue") {
        const newRow = bodyData.row;
        if (!newRow || typeof newRow !== "object") {
          return res.status(400).json({ error: "Missing row data" });
        }

        let existingRows = [];
        let sourceName = "Call Log";
        const getR = await r2Fetch("GET", "");
        if (getR.statusCode === 200) {
          try {
            const parsed = JSON.parse(getR.body);
            if (parsed && Array.isArray(parsed.rows)) {
              existingRows = parsed.rows;
              sourceName = parsed.sourceName || sourceName;
            }
          } catch (_) {}
        }

        const cdNew = String(newRow["Call Details"] || newRow["call details"] || "").trim();
        const dateNew = String(newRow["Date"] || newRow["date"] || "").trim();

        if (cdNew) {
          const m = cdNew.match(/_([^_]+)_Hotline/i);
          let extracted = "";
          if (m && !/^NPP\s/i.test(m[1]) && !/^Ticket/i.test(m[1])) {
            extracted = m[1].trim();
          } else {
            const fb = cdNew.match(/_(HQ\s+[^_]+|\d+[A-Z]\d+|ADMIN|ASM|SUP)(?:_|$)/i);
            if (fb) extracted = fb[1].trim();
          }
          if (extracted) {
            newRow["User code"] = extracted;
            newRow["User Code"] = extracted;
          }
        }

        const isDup = existingRows.some(r => {
          const cd = String(r["Call Details"] || r["call details"] || "").trim();
          const d = String(r["Date"] || r["date"] || "").trim();
          return cd === cdNew && d === dateNew;
        });

        if (isDup) {
          return res.status(200).json({
            status: "duplicate",
            message: "Dòng Call Log này đã tồn tại trong ngày",
            rowCount: existingRows.length
          });
        }

        existingRows.unshift(newRow);
        const payload = {
          status: "success",
          sourceName: sourceName,
          updatedAt: Date.now(),
          rowCount: existingRows.length,
          rows: existingRows
        };

        const putR = await r2Fetch("PUT", JSON.stringify(payload));
        if (putR.statusCode >= 200 && putR.statusCode < 300) {
          return res.status(200).json({
            status: "success",
            action: "append_row",
            updatedAt: payload.updatedAt,
            rowCount: payload.rowCount
          });
        } else {
          return res.status(502).json({ error: "R2 PUT failed", status: putR.statusCode });
        }
      }

      // Hỗ trợ action: delete_row để xóa 1 dòng cụ thể
      if (bodyData.action === "delete_row") {
        const targetCd = String(bodyData.callDetails || "").trim();
        const targetDate = String(bodyData.date || "").trim();
        if (!targetCd) {
          return res.status(400).json({ error: "Missing callDetails to delete" });
        }

        let existingRows = [];
        let sourceName = "Call Log";
        const getR = await r2Fetch("GET", "");
        if (getR.statusCode === 200) {
          try {
            const parsed = JSON.parse(getR.body);
            if (parsed && Array.isArray(parsed.rows)) {
              existingRows = parsed.rows;
              sourceName = parsed.sourceName || sourceName;
            }
          } catch (_) {}
        }

        const initialCount = existingRows.length;
        let removed = false;
        existingRows = existingRows.filter(r => {
          if (removed) return true;
          const cd = String(r["Call Details"] || r["call details"] || "").trim();
          const d = String(r["Date"] || r["date"] || "").trim();
          if (cd === targetCd && (!targetDate || d === targetDate)) {
            removed = true;
            return false;
          }
          return true;
        });

        if (!removed) {
          return res.status(404).json({ error: "Row not found in Call Log" });
        }

        const payload = {
          status: "success",
          sourceName: sourceName,
          updatedAt: Date.now(),
          rowCount: existingRows.length,
          rows: existingRows
        };

        const putR = await r2Fetch("PUT", JSON.stringify(payload));
        if (putR.statusCode >= 200 && putR.statusCode < 300) {
          return res.status(200).json({
            status: "success",
            action: "delete_row",
            deletedCount: 1,
            rowCount: payload.rowCount,
            updatedAt: payload.updatedAt
          });
        } else {
          return res.status(502).json({ error: "R2 PUT failed", status: putR.statusCode });
        }
      }

      // Hỗ trợ action: delete_by_date để xóa tất cả dòng theo 1 ngày
      if (bodyData.action === "delete_by_date") {
        const targetDate = String(bodyData.date || "").trim();
        if (!targetDate) {
          return res.status(400).json({ error: "Missing date to delete" });
        }

        let existingRows = [];
        let sourceName = "Call Log";
        const getR = await r2Fetch("GET", "");
        if (getR.statusCode === 200) {
          try {
            const parsed = JSON.parse(getR.body);
            if (parsed && Array.isArray(parsed.rows)) {
              existingRows = parsed.rows;
              sourceName = parsed.sourceName || sourceName;
            }
          } catch (_) {}
        }

        const initialCount = existingRows.length;
        existingRows = existingRows.filter(r => {
          const d = String(r["Date"] || r["date"] || "").trim();
          return d !== targetDate && !d.startsWith(targetDate);
        });

        const deletedCount = initialCount - existingRows.length;
        const payload = {
          status: "success",
          sourceName: sourceName,
          updatedAt: Date.now(),
          rowCount: existingRows.length,
          rows: existingRows
        };

        const putR = await r2Fetch("PUT", JSON.stringify(payload));
        if (putR.statusCode >= 200 && putR.statusCode < 300) {
          return res.status(200).json({
            status: "success",
            action: "delete_by_date",
            deletedCount: deletedCount,
            rowCount: payload.rowCount,
            updatedAt: payload.updatedAt
          });
        } else {
          return res.status(502).json({ error: "R2 PUT failed", status: putR.statusCode });
        }
      }

      // Hỗ trợ action: delete_rows / delete_multiple để xóa nhiều dòng cùng lúc
      if (bodyData.action === "delete_rows" || bodyData.action === "delete_multiple") {
        const items = Array.isArray(bodyData.items) ? bodyData.items : [];
        if (!items.length) {
          return res.status(400).json({ error: "Missing items to delete" });
        }

        let existingRows = [];
        let sourceName = "Call Log";
        const getR = await r2Fetch("GET", "");
        if (getR.statusCode === 200) {
          try {
            const parsed = JSON.parse(getR.body);
            if (parsed && Array.isArray(parsed.rows)) {
              existingRows = parsed.rows;
              sourceName = parsed.sourceName || sourceName;
            }
          } catch (_) {}
        }

        const targetKeys = new Set(items.map(it => {
          const cd = String(it.callDetails || it["Call Details"] || "").trim();
          const d = String(it.date || it.Date || "").trim();
          return `${cd}___${d}`;
        }));

        const initialCount = existingRows.length;
        existingRows = existingRows.filter(r => {
          const cd = String(r["Call Details"] || r["call details"] || "").trim();
          const d = String(r["Date"] || r["date"] || "").trim();
          const key1 = `${cd}___${d}`;
          const key2 = `${cd}___`;
          return !targetKeys.has(key1) && !targetKeys.has(key2);
        });

        const deletedCount = initialCount - existingRows.length;
        const payload = {
          status: "success",
          sourceName: sourceName,
          updatedAt: Date.now(),
          rowCount: existingRows.length,
          rows: existingRows
        };

        const putR = await r2Fetch("PUT", JSON.stringify(payload));
        if (putR.statusCode >= 200 && putR.statusCode < 300) {
          return res.status(200).json({
            status: "success",
            action: "delete_rows",
            deletedCount: deletedCount,
            rowCount: payload.rowCount,
            updatedAt: payload.updatedAt
          });
        } else {
          return res.status(502).json({ error: "R2 PUT failed", status: putR.statusCode });
        }
      }

      // Format payload object cho các request upload toàn bộ
      let rawRows = Array.isArray(bodyData) ? bodyData : (Array.isArray(bodyData.rows) ? bodyData.rows : []);
      const sanitizedRows = rawRows.map(sanitizeRowUserCode);
      const payload = {
        status: "success",
        sourceName: bodyData.sourceName || (Array.isArray(bodyData) ? "Call Log Upload" : "Call Log Upload"),
        updatedAt: Date.now(),
        rowCount: sanitizedRows.length,
        rows: sanitizedRows
      };

      const putBody = JSON.stringify(payload);
      const putR = await r2Fetch("PUT", putBody);

      if (putR.statusCode >= 200 && putR.statusCode < 300) {
        let etag = "";
        if (putR.headers) {
          etag = putR.headers["etag"] || putR.headers["ETag"] || "";
        }
        if (!etag) {
          etag = `"${payload.updatedAt}"`;
        }
        res.setHeader("ETag", etag);
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        return res.status(200).json({
          status: "success",
          updatedAt: payload.updatedAt,
          rowCount: payload.rowCount,
          sourceName: payload.sourceName,
          etag: etag
        });
      } else {
        return res.status(502).json({ error: "R2 PUT failed", status: putR.statusCode, detail: putR.body });
      }
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
};
