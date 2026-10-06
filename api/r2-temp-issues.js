try { require("dotenv").config(); } catch(_) {}
const https = require("https");
const crypto = require("crypto");

const R2_ACCOUNT_ID        = process.env.R2_ACCOUNT_ID_DYLAN        || process.env.R2_ACCOUNT_ID        || "";
const R2_ACCESS_KEY_ID     = process.env.R2_ACCESS_KEY_ID_DYLAN     || process.env.R2_ACCESS_KEY_ID     || "";
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY_DYLAN || process.env.R2_SECRET_ACCESS_KEY || "";
const R2_BUCKET_NAME       = process.env.R2_BUCKET_NAME_DYLAN       || process.env.R2_BUCKET_NAME       || "";
const R2_OBJECT_KEY        = "dms_temp_issues.json";

function hmacSha256(key, msg, enc) {
  return crypto.createHmac("sha256", key).update(msg, "utf8").digest(enc);
}
function sha256hex(msg) {
  const buf = Buffer.isBuffer(msg) ? msg : Buffer.from(String(msg || ""), "utf8");
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function buildR2Request(method, body, objectKey = R2_OBJECT_KEY) {
  const bodyBuf = body ? (Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8")) : Buffer.alloc(0);
  const host      = R2_ACCOUNT_ID + ".r2.cloudflarestorage.com";
  const uriPath   = "/" + R2_BUCKET_NAME + "/" + (objectKey || R2_OBJECT_KEY);
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

function r2Fetch(method, body, objectKey = R2_OBJECT_KEY) {
  body = body || "";
  return new Promise(function(resolve, reject) {
    const info = buildR2Request(method, body, objectKey);
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

function normalizeMemberCode(code) {
  return String(code || "").trim().toUpperCase();
}

function cleanResultStr(s) {
  return String(s || "").trim().toLowerCase();
}

function deduplicateTempNotes(notes) {
  if (!Array.isArray(notes)) return [];
  const seen = new Set();
  const res = [];
  for (const n of notes) {
    if (!n || !n.result) continue;
    const textKey = cleanResultStr(n.result);
    const dateKey = String(n.date || "").trim();
    const k = `${dateKey}__${textKey}`;
    if (!seen.has(k)) {
      seen.add(k);
      res.push(n);
    }
  }
  return res;
}

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Expose-Headers": "ETag, Last-Modified"
};

module.exports = async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === "OPTIONS") return res.status(204).end();

  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  try {
    // ── GET: Lấy danh sách tạm từ R2 (theo memberCode hoặc toàn bộ) ──
    if (req.method === "GET") {
      const url = new URL(req.url, "http://localhost");
      const memberCode = normalizeMemberCode(url.searchParams.get("memberCode"));

      const r2Res = await r2Fetch("GET", "");
      if (r2Res.statusCode === 404) {
        return res.status(200).json({
          status: "success",
          memberCode: memberCode,
          notes: [],
          count: 0,
          tempByMember: {}
        });
      }

      if (r2Res.statusCode === 200) {
        let parsed = {};
        try { parsed = JSON.parse(r2Res.body); } catch (_) {}
        const tempByMember = parsed.tempByMember || {};

        if (memberCode) {
          const notes = Array.isArray(tempByMember[memberCode]) ? tempByMember[memberCode] : [];
          return res.status(200).json({
            status: "success",
            memberCode: memberCode,
            notes: deduplicateTempNotes(notes),
            count: notes.length,
            updatedAt: parsed.updatedAt || Date.now()
          });
        }

        return res.status(200).json({
          status: "success",
          tempByMember: tempByMember,
          updatedAt: parsed.updatedAt || Date.now()
        });
      }

      return res.status(502).json({ error: "R2 GET failed", status: r2Res.statusCode });
    }

    // ── POST: Cập nhật danh sách tạm theo nhân viên trên R2 ──
    if (req.method === "POST") {
      let bodyData = req.body;
      if (typeof bodyData === "string") {
        try { bodyData = JSON.parse(bodyData); } catch (_) {}
      }

      if (!bodyData || typeof bodyData !== "object") {
        return res.status(400).json({ error: "Invalid body data" });
      }

      // 1. Đọc dữ liệu hiện tại từ R2
      let storedData = { status: "success", tempByMember: {}, updatedAt: Date.now() };
      const getR = await r2Fetch("GET", "");
      if (getR.statusCode === 200) {
        try {
          const p = JSON.parse(getR.body);
          if (p && typeof p.tempByMember === "object") storedData = p;
        } catch (_) {}
      }
      if (!storedData.tempByMember) storedData.tempByMember = {};

      const action = bodyData.action || "save_member_temp";
      const memberCode = normalizeMemberCode(bodyData.memberCode || bodyData.note?.memberCode);

      if (!memberCode && action !== "save_all") {
        return res.status(400).json({ error: "memberCode is required for " + action });
      }

      // Action 1: Lưu toàn bộ danh sách tạm của 1 nhân viên
      if (action === "save_member_temp") {
        const inputNotes = Array.isArray(bodyData.notes) ? bodyData.notes : [];
        storedData.tempByMember[memberCode] = deduplicateTempNotes(inputNotes);
      }
      // Action 2: Thêm 1 note vào danh sách tạm của nhân viên
      else if (action === "add_temp_note" && bodyData.note) {
        let currentList = Array.isArray(storedData.tempByMember[memberCode]) ? storedData.tempByMember[memberCode] : [];
        currentList.unshift(bodyData.note);
        storedData.tempByMember[memberCode] = deduplicateTempNotes(currentList);
      }
      // Action 3: Xoá 1 note theo ID của nhân viên
      else if (action === "delete_member_temp" && bodyData.id) {
        let currentList = Array.isArray(storedData.tempByMember[memberCode]) ? storedData.tempByMember[memberCode] : [];
        storedData.tempByMember[memberCode] = currentList.filter(n => n.id !== bodyData.id);
      }
      // Action 4: Xoá toàn bộ danh sách tạm của 1 nhân viên
      else if (action === "clear_member_temp") {
        storedData.tempByMember[memberCode] = [];
      }
      // Action 5: Save all dict
      else if (action === "save_all" && bodyData.tempByMember) {
        storedData.tempByMember = bodyData.tempByMember;
      }

      storedData.updatedAt = Date.now();
      storedData.status = "success";

      const putBody = JSON.stringify(storedData);
      const putRes = await r2Fetch("PUT", putBody);

      if (putRes.statusCode >= 200 && putRes.statusCode < 300) {
        const memberNotes = storedData.tempByMember[memberCode] || [];
        return res.status(200).json({
          status: "success",
          memberCode: memberCode,
          count: memberNotes.length,
          notes: memberNotes,
          updatedAt: storedData.updatedAt
        });
      } else {
        return res.status(502).json({ error: "R2 PUT failed", status: putRes.statusCode, detail: putRes.body });
      }
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
};
