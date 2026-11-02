try { require("dotenv").config(); } catch(_) {}

const R2_ACCOUNT_ID        = process.env.R2_ACCOUNT_ID_DYLAN        || process.env.R2_ACCOUNT_ID        || "b63e9e1ed38dbfd59b2e77a28bb00a36";
const R2_ACCESS_KEY_ID     = process.env.R2_ACCESS_KEY_ID_DYLAN     || process.env.R2_ACCESS_KEY_ID     || "30d0d30195468279bab5ca499ff39cf0";
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY_DYLAN || process.env.R2_SECRET_ACCESS_KEY || "7f2dc82f5e23d39b0743fbd615ce1ea964f4e182806c0c18ba81fac706c777bd";
const R2_BUCKET_NAME       = process.env.R2_BUCKET_NAME_DYLAN       || process.env.R2_BUCKET_NAME       || "dylan";
const R2_OBJECT_KEY        = "dms_blocked_devices.json";

const REQUIRED_PASS = "5smaidinh";
const LOCK_DURATION_MS = 24 * 60 * 60 * 1000; // 24 tiếng

// ── Web Crypto helpers ────────────────────────────────────────────────────────
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

function getClientIp(req) {
  const h = req.headers || {};
  return (
    h["cf-connecting-ip"] ||
    h["x-real-ip"] ||
    (h["x-forwarded-for"] ? h["x-forwarded-for"].split(",")[0].trim() : "") ||
    req.clientIp ||
    "127.0.0.1"
  );
}

async function loadBlockedData() {
  try {
    const res = await r2Fetch("GET", "");
    if (res.statusCode === 200 && res.body) {
      const data = JSON.parse(res.body);
      if (data && typeof data === "object") {
        if (!Array.isArray(data.blockedList)) data.blockedList = [];
        if (!data.failedAttempts) data.failedAttempts = {};
        return data;
      }
    }
  } catch (_) {}
  return { blockedList: [], failedAttempts: {}, updatedAt: Date.now() };
}

async function saveBlockedData(data) {
  try {
    data.updatedAt = Date.now();
    await r2Fetch("PUT", JSON.stringify(data));
  } catch (err) {
    console.error("saveBlockedData error:", err);
  }
}

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Expose-Headers": "ETag, Last-Modified"
};

module.exports = async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === "OPTIONS") return res.status(204).end();

  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  const clientIp = getClientIp(req);

  try {
    const store = await loadBlockedData();
    const now = Date.now();

    // Dọn dẹp các bản ghi khóa đã hết hạn (> 24h)
    store.blockedList = store.blockedList.filter(item => item && item.lockedUntil > now);

    // ── GET: Kiểm tra thiết bị / IP có đang bị khóa hay không ──
    if (req.method === "GET") {
      const _u = new URL(req.url, "http://localhost");
      const hwid = (_u.searchParams.get("hwid") || "").trim();

      const matchedBlock = store.blockedList.find(b => 
        (hwid && b.hwid === hwid) || (clientIp && b.ip === clientIp)
      );

      if (matchedBlock && matchedBlock.lockedUntil > now) {
        return res.status(200).json({
          status: "blocked",
          blocked: true,
          hwid: matchedBlock.hwid || hwid,
          ip: clientIp,
          lockedAt: matchedBlock.lockedAt,
          lockedUntil: matchedBlock.lockedUntil,
          remainingMs: matchedBlock.lockedUntil - now,
          reason: matchedBlock.reason || "Sai mật khẩu 3 lần liên tiếp"
        });
      }

      return res.status(200).json({
        status: "ok",
        blocked: false,
        hwid: hwid,
        ip: clientIp
      });
    }

    // ── POST: Xác thực mật khẩu hoặc ghi nhận khóa ──
    if (req.method === "POST") {
      let bodyData = req.body;
      if (typeof bodyData === "string") {
        try { bodyData = JSON.parse(bodyData); } catch (_) {}
      }
      bodyData = bodyData || {};

      const action = bodyData.action || "verify";
      const hwid = String(bodyData.hwid || "").trim();
      const password = String(bodyData.password || "").trim();

      // Kiểm tra nếu đang bị khóa sẵn
      const matchedBlock = store.blockedList.find(b => 
        (hwid && b.hwid === hwid) || (clientIp && b.ip === clientIp)
      );
      if (matchedBlock && matchedBlock.lockedUntil > now) {
        return res.status(403).json({
          status: "blocked",
          blocked: true,
          hwid: matchedBlock.hwid || hwid,
          ip: clientIp,
          lockedUntil: matchedBlock.lockedUntil,
          remainingMs: matchedBlock.lockedUntil - now,
          reason: matchedBlock.reason || "Thiết bị hoặc IP đang bị khóa"
        });
      }

      // Xử lý action verify mật khẩu
      if (action === "verify") {
        const attemptKey = hwid || clientIp;

        if (password === REQUIRED_PASS) {
          // Đúng mật khẩu: xóa lịch sử đếm lỗi của thiết bị/IP này
          if (store.failedAttempts[attemptKey]) {
            delete store.failedAttempts[attemptKey];
            await saveBlockedData(store);
          }
          const authToken = await sha256hex(`${attemptKey}__${REQUIRED_PASS}__AUTH_OK_2026`);
          return res.status(200).json({
            status: "success",
            success: true,
            message: "Xác thực thành công",
            token: authToken,
            hwid: hwid,
            ip: clientIp
          });
        }

        // Sai mật khẩu: tính số lần thử
        const currentFails = (store.failedAttempts[attemptKey] || 0) + 1;
        store.failedAttempts[attemptKey] = currentFails;

        if (currentFails >= 3) {
          // KHÓA 24 TIẾNG!
          const lockedUntil = now + LOCK_DURATION_MS;
          const blockRecord = {
            hwid: hwid || "UNKNOWN_HWID",
            ip: clientIp,
            lockedAt: now,
            lockedUntil: lockedUntil,
            reason: "Nhập sai mật khẩu hệ thống 3 lần liên tiếp"
          };
          store.blockedList.push(blockRecord);
          delete store.failedAttempts[attemptKey];
          await saveBlockedData(store);

          return res.status(403).json({
            status: "blocked",
            blocked: true,
            success: false,
            message: "Thiết bị và IP mạng đã bị khóa trong 24 tiếng do nhập sai 3 lần!",
            attemptsLeft: 0,
            hwid: hwid,
            ip: clientIp,
            lockedAt: now,
            lockedUntil: lockedUntil,
            remainingMs: LOCK_DURATION_MS
          });
        }

        // Chưa đủ 3 lần
        await saveBlockedData(store);
        const attemptsLeft = 3 - currentFails;
        return res.status(401).json({
          status: "error",
          success: false,
          blocked: false,
          message: `Mật khẩu không chính xác! Bạn còn ${attemptsLeft} lần thử.`,
          attemptsLeft: attemptsLeft,
          hwid: hwid,
          ip: clientIp
        });
      }

      // Action cưỡng chế khóa từ client (nếu client tự đếm sai 3 lần)
      if (action === "force_lock") {
        const lockedUntil = now + LOCK_DURATION_MS;
        const blockRecord = {
          hwid: hwid || "UNKNOWN_HWID",
          ip: clientIp,
          lockedAt: now,
          lockedUntil: lockedUntil,
          reason: bodyData.reason || "Client lock: Sai mật khẩu 3 lần"
        };
        store.blockedList.push(blockRecord);
        await saveBlockedData(store);

        return res.status(200).json({
          status: "blocked",
          blocked: true,
          hwid: hwid,
          ip: clientIp,
          lockedUntil: lockedUntil,
          remainingMs: LOCK_DURATION_MS
        });
      }

      return res.status(400).json({ error: "Invalid action" });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
