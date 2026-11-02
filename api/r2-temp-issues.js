try { require("dotenv").config(); } catch(_) {}

const R2_ACCOUNT_ID        = process.env.R2_ACCOUNT_ID_DYLAN        || process.env.R2_ACCOUNT_ID        || "b63e9e1ed38dbfd59b2e77a28bb00a36";
const R2_ACCESS_KEY_ID     = process.env.R2_ACCESS_KEY_ID_DYLAN     || process.env.R2_ACCESS_KEY_ID     || "30d0d30195468279bab5ca499ff39cf0";
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY_DYLAN || process.env.R2_SECRET_ACCESS_KEY || "7f2dc82f5e23d39b0743fbd615ce1ea964f4e182806c0c18ba81fac706c777bd";
const R2_BUCKET_NAME       = process.env.R2_BUCKET_NAME_DYLAN       || process.env.R2_BUCKET_NAME       || "dylan";
const R2_OBJECT_KEY        = "dms_temp_issues.json";


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
