try { require("dotenv").config(); } catch(_) {}
const https = require("https");
const crypto = require("crypto");

const R2_ACCOUNT_ID        = process.env.R2_ACCOUNT_ID_DYLAN        || process.env.R2_ACCOUNT_ID        || "";
const R2_ACCESS_KEY_ID     = process.env.R2_ACCESS_KEY_ID_DYLAN     || process.env.R2_ACCESS_KEY_ID     || "";
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY_DYLAN || process.env.R2_SECRET_ACCESS_KEY || "";
const R2_BUCKET_NAME       = process.env.R2_BUCKET_NAME_DYLAN       || process.env.R2_BUCKET_NAME       || "";
const R2_OBJECT_KEY        = "dms_note_issues.json";

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

/**
 * Trích xuất và định dạng một Issue thành dòng Call Log hợp lệ
 */
function buildCallLogRow(issue, dtRows = []) {
  const resultText = String(issue.result || "").trim();
  const dateStr = String(issue.date || "").trim();

  // 1. Dist code
  let distCode = (issue.fields?.distCode || issue.fields?.nppCode || issue.distCode || "").trim();
  if (!distCode) {
    const nppMatch = resultText.match(/_NPP\s+([^_]+)/i);
    const nppName = nppMatch ? nppMatch[1].trim().toLowerCase() : "";
    if (nppName && dtRows.length > 0) {
      const found = dtRows.find(d => {
        const iss = String(d.col_issue_name || "").replace(/^npp\s+/i, "").trim().toLowerCase();
        const full = String(d.col_npp_name || "").trim().toLowerCase();
        return iss === nppName || full.includes(nppName);
      });
      if (found && found.col_dt_code) {
        distCode = String(found.col_dt_code).trim();
      }
    }
  }

  // 2. User code / User Code
  let userCode = "";
  if (resultText) {
    const m = resultText.match(/_([^_]+)_\s*Hotline/i);
    if (m && !/^NPP\s/i.test(m[1]) && !/^Ticket/i.test(m[1])) {
      userCode = m[1].trim();
    } else {
      const fb = resultText.match(/_(HQ\s+[^_]+|\d+[A-Z]\d+|ADMIN|ASM|SUP)(?:_|$)/i);
      if (fb) userCode = fb[1].trim();
    }
  }
  if (!userCode) {
    userCode = (issue.fields?.nvbhFormatted || issue.fields?.nvbh || issue.fields?.role || "").trim();
  }

  // 3. Hotline
  let hotline = (issue.fields?.hotline || "").trim();
  if (!hotline && resultText) {
    const m = resultText.match(/_Hotline[_\s]+([0-9a-zA-Z]+)/i);
    if (m) hotline = m[1].trim();
  }

  return {
    "Dist code": distCode,
    "User Code": userCode,
    "User code": userCode,
    "Hotline": hotline,
    "Date": dateStr,
    "Call Details": resultText
  };
}

/**
 * Ghi nhận một Issue mới vào Call Log trên R2
 */
async function appendIssueToCallLog(issue) {
  if (!issue || !issue.result) return false;
  try {
    const CALL_LOG_KEY = "dms_call_log.json";
    const DT_KEY = "dms_dt_list.json";

    // 1. Tải danh sách Call Log hiện tại
    let callLogData = { status: "success", sourceName: "Call Log", rowCount: 0, rows: [] };
    const getClRes = await r2Fetch("GET", "", CALL_LOG_KEY);
    if (getClRes.statusCode === 200) {
      try {
        const parsed = JSON.parse(getClRes.body);
        if (parsed && Array.isArray(parsed.rows)) {
          callLogData = parsed;
        }
      } catch (_) {}
    }

    const rows = Array.isArray(callLogData.rows) ? callLogData.rows : [];
    const resultText = String(issue.result || "").trim();
    const dateStr = String(issue.date || "").trim();

    // 2. Kiểm tra xem đã có dòng này trong Call Log chưa
    const alreadyExists = rows.some(r => {
      const cd = String(r["Call Details"] || r["call details"] || "").trim();
      const d = String(r["Date"] || r["date"] || "").trim();
      return cd === resultText && d === dateStr;
    });

    if (alreadyExists) {
      return true; // Đã có rồi, không trùng lặp
    }

    // 3. Đọc danh sách DT nếu cần tìm distCode
    let dtRows = [];
    if (!issue.fields?.distCode && !issue.distCode) {
      try {
        const dtRes = await r2Fetch("GET", "", DT_KEY);
        if (dtRes.statusCode === 200) {
          const dtData = JSON.parse(dtRes.body);
          dtRows = Array.isArray(dtData.rows) ? dtData.rows : [];
        }
      } catch (_) {}
    }

    const newRow = buildCallLogRow(issue, dtRows);

    // Chèn lên đầu danh sách để hiển thị mới nhất
    rows.unshift(newRow);
    callLogData.rows = rows;
    callLogData.rowCount = rows.length;
    callLogData.updatedAt = Date.now();

    const putRes = await r2Fetch("PUT", JSON.stringify(callLogData), CALL_LOG_KEY);
    return putRes.statusCode >= 200 && putRes.statusCode < 300;
  } catch (err) {
    console.error("Lỗi tự động ghi nhận Call Log:", err);
    return false;
  }
}

/**
 * Đồng bộ danh sách Issue vào Call Log
 */
async function syncIssuesToCallLog(issuesList) {
  if (!Array.isArray(issuesList) || issuesList.length === 0) return 0;
  try {
    const CALL_LOG_KEY = "dms_call_log.json";
    const DT_KEY = "dms_dt_list.json";

    let callLogData = { status: "success", sourceName: "Call Log", rowCount: 0, rows: [] };
    const getClRes = await r2Fetch("GET", "", CALL_LOG_KEY);
    if (getClRes.statusCode === 200) {
      try {
        const parsed = JSON.parse(getClRes.body);
        if (parsed && Array.isArray(parsed.rows)) callLogData = parsed;
      } catch (_) {}
    }

    const rows = Array.isArray(callLogData.rows) ? callLogData.rows : [];
    let dtRows = [];
    try {
      const dtRes = await r2Fetch("GET", "", DT_KEY);
      if (dtRes.statusCode === 200) {
        const dtData = JSON.parse(dtRes.body);
        dtRows = Array.isArray(dtData.rows) ? dtData.rows : [];
      }
    } catch (_) {}

    let addedCount = 0;
    const sorted = [...issuesList].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

    for (const iss of sorted) {
      const resultText = String(iss.result || "").trim();
      const dateStr = String(iss.date || "").trim();
      if (!resultText) continue;

      const exists = rows.some(r => {
        const cd = String(r["Call Details"] || r["call details"] || "").trim();
        const d = String(r["Date"] || r["date"] || "").trim();
        return cd === resultText && d === dateStr;
      });
      if (exists) continue;

      const row = buildCallLogRow(iss, dtRows);
      rows.unshift(row);
      addedCount++;
    }

    if (addedCount > 0) {
      callLogData.rows = rows;
      callLogData.rowCount = rows.length;
      callLogData.updatedAt = Date.now();
      await r2Fetch("PUT", JSON.stringify(callLogData), CALL_LOG_KEY);
    }
    return addedCount;
  } catch (err) {
    console.error("Lỗi đồng bộ Issue sang Call Log:", err);
    return 0;
  }
}

function cleanResultStr(s) {
  return String(s || "").trim().toLowerCase();
}

// Hàm chuẩn hoá deduplicate danh sách issue:
// Cho phép trùng nếu khác ngày (tính theo ngày) hoặc khác nhân viên.
// Chỉ chặn trùng nếu CÙNG nhân viên + CÙNG ngày + CÙNG nội dung note.
function deduplicateIssues(issues) {
  if (!Array.isArray(issues)) return [];
  const seen = new Set();
  const result = [];
  for (const item of issues) {
    if (!item || !item.result) continue;
    const textKey = cleanResultStr(item.result);
    const memberKey = String(item.memberCode || "").trim().toUpperCase();
    const dateKey = String(item.date || "").trim();
    const uniqueKey = `${memberKey}__${dateKey}__${textKey}`;
    if (!seen.has(uniqueKey)) {
      seen.add(uniqueKey);
      result.push(item);
    }
  }
  return result;
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
  res.setHeader("Content-Type", "application/json; charset=utf-8");

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
        return res.status(200).json({ status: "not_found", issues: [], count: 0 });
      }

      if (r2Res.statusCode === 200) {
        try {
          const parsed = JSON.parse(r2Res.body);
          const issues = Array.isArray(parsed.issues) ? parsed.issues : (Array.isArray(parsed) ? parsed : []);
          return res.status(200).json({
            status: "success",
            issues: deduplicateIssues(issues),
            updatedAt: parsed.updatedAt || Date.now(),
            count: issues.length
          });
        } catch (_) {
          return res.status(200).json({ status: "success", issues: [], count: 0 });
        }
      }

      return res.status(502).json({ error: "R2 GET failed", status: r2Res.statusCode });
    }

    if (req.method === "POST") {
      let bodyData = req.body;
      if (typeof bodyData === "string") {
        try { bodyData = JSON.parse(bodyData); } catch (_) {}
      }

      if (!bodyData || typeof bodyData !== "object") {
        return res.status(400).json({ error: "Invalid body data" });
      }

      // Đọc dữ liệu hiện tại từ R2 để merge an toàn
      let currentIssues = [];
      const getR = await r2Fetch("GET", "");
      if (getR.statusCode === 200) {
        try {
          const parsed = JSON.parse(getR.body);
          currentIssues = Array.isArray(parsed.issues) ? parsed.issues : (Array.isArray(parsed) ? parsed : []);
        } catch (_) {}
      }

      const action = bodyData.action || "save_all";

      // 1. Thêm 1 Issue mới có kiểm tra trùng lặp theo ngày và nhân viên
      if (action === "add_issue" && bodyData.issue) {
        const newIssue = bodyData.issue;
        const textKey = cleanResultStr(newIssue.result);
        const memberKey = String(newIssue.memberCode || "").trim().toUpperCase();
        const dateKey = String(newIssue.date || "").trim();

        // Kiểm tra xem đã có ghi chú này của nhân viên này trong CÙNG NGÀY hay chưa
        const isDuplicate = currentIssues.some(item => {
          const itText = cleanResultStr(item.result);
          const itMember = String(item.memberCode || "").trim().toUpperCase();
          const itDate = String(item.date || "").trim();
          return itText === textKey && itMember === memberKey && itDate === dateKey;
        });

        if (isDuplicate) {
          return res.status(200).json({
            status: "duplicate",
            message: "Ghi chú này đã được lưu trong ngày hôm nay rồi!",
            issues: deduplicateIssues(currentIssues),
            count: currentIssues.length
          });
        }

        // Thêm vào đầu danh sách
        currentIssues.unshift(newIssue);
      }
      // 2. Xóa 1 Issue theo id
      else if (action === "delete_issue" && bodyData.id) {
        currentIssues = currentIssues.filter(item => item.id !== bodyData.id);
      }
      // 3. Xoá tất cả
      else if (action === "clear_all") {
        currentIssues = [];
      }
      // 4. Đồng bộ tất cả Issue sang Call Log
      else if (action === "sync_calllog") {
        const issuesToSync = deduplicateIssues(currentIssues);
        const syncedCount = await syncIssuesToCallLog(issuesToSync);
        return res.status(200).json({
          status: "success",
          message: `Đã đồng bộ ${syncedCount} issue sang Call Log!`,
          syncedCount: syncedCount,
          count: issuesToSync.length
        });
      }
      // 5. Đồng bộ từ Temp local lên R2 (sync_issues) - merge dedup + ghi Call Log
      else if (action === "sync_issues") {
        const inputIssues = Array.isArray(bodyData.issues) ? bodyData.issues : [];
        // Merge: input issues + hiện tại trên R2, dedup theo key
        const mergeMap = new Map();
        const makeKey = (it) => `${String(it.memberCode||'').trim().toUpperCase()}|${String(it.date||'').trim()}|${cleanResultStr(it.result)}`;
        currentIssues.forEach(it => {
          if (it && it.result) mergeMap.set(makeKey(it), it);
        });
        inputIssues.forEach(it => {
          if (it && it.result) {
            const k = makeKey(it);
            if (!mergeMap.has(k)) mergeMap.set(k, it);
          }
        });
        currentIssues = Array.from(mergeMap.values());
      }
      // 6. Đồng bộ / Merge nhiều issues (save_all / sync)
      else {
        const inputIssues = Array.isArray(bodyData.issues) ? bodyData.issues : (Array.isArray(bodyData) ? bodyData : []);
        if (action === "merge") {
          currentIssues = [...inputIssues, ...currentIssues];
        } else {
          currentIssues = inputIssues;
        }
      }

      const cleanIssues = deduplicateIssues(currentIssues);
      const payload = {
        status: "success",
        updatedAt: Date.now(),
        count: cleanIssues.length,
        issues: cleanIssues
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

        // Nếu là sync_issues -> Đồng bộ tất cả sang Call Log
        let callLogRecorded = false;
        if (action === "add_issue" && bodyData.issue) {
          try {
            callLogRecorded = await appendIssueToCallLog(bodyData.issue);
          } catch (e) {
            console.error("Lỗi khi ghi nhận Call Log:", e);
          }
        } else if (action === "sync_issues") {
          try {
            const synced = await syncIssuesToCallLog(cleanIssues);
            callLogRecorded = synced > 0;
          } catch (e) {
            console.error("Lỗi khi sync Call Log:", e);
          }
        }

        return res.status(200).json({
          status: "success",
          updatedAt: payload.updatedAt,
          count: payload.count,
          issues: cleanIssues,
          callLogRecorded: callLogRecorded,
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
