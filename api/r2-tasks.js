try { require("dotenv").config(); } catch(_) {}
const https = require("https");
const crypto = require("crypto");

const R2_ACCOUNT_ID        = process.env.R2_ACCOUNT_ID_DYLAN        || process.env.R2_ACCOUNT_ID        || "";
const R2_ACCESS_KEY_ID     = process.env.R2_ACCESS_KEY_ID_DYLAN     || process.env.R2_ACCESS_KEY_ID     || "";
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY_DYLAN || process.env.R2_SECRET_ACCESS_KEY || "";
const R2_BUCKET_NAME       = process.env.R2_BUCKET_NAME_DYLAN       || process.env.R2_BUCKET_NAME       || "";
const R2_OBJECT_KEY        = "task_pending_data.json";

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

// Đọc dữ liệu hiện tại từ R2, fallback về object trống nếu chưa có hoặc lỗi
async function getTasksData() {
  const getR = await r2Fetch("GET", "");
  if (getR.statusCode === 200) {
    try {
      const data = JSON.parse(getR.body);
      const members = (data.members || []).map(m => {
        if (typeof m === "string") return { name: m.trim(), code: "" };
        return { name: (m.name || "").trim(), code: (m.code || "").trim() };
      });
      return {
        tasks: data.tasks || [],
        members: members,
        projects: data.projects || []
      };
    } catch (e) {
      return { tasks: [], members: [], projects: [] };
    }
  }
  return { tasks: [], members: [], projects: [] };
}

// Lưu dữ liệu vào R2
async function saveTasksData(data) {
  const putBody = JSON.stringify(data);
  const putR = await r2Fetch("PUT", putBody);
  if (putR.statusCode >= 200 && putR.statusCode < 300) {
    return { status: "success", data };
  } else {
    throw new Error("R2 PUT failed HTTP " + putR.statusCode + ": " + putR.body);
  }
}

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
      return res.status(200).end();
    }

    if (req.method === "GET") {
      const urlParts = require("url").parse(req.url, true);
      const action = urlParts.query.action;

      const r2Res = await r2Fetch("GET", "");
      if (r2Res.headers) {
        const etag = r2Res.headers["etag"] || r2Res.headers["ETag"] || "";
        const lm = r2Res.headers["last-modified"] || r2Res.headers["Last-Modified"] || "";
        if (etag) res.setHeader("ETag", etag);
        if (lm) res.setHeader("Last-Modified", lm);
      }

      let data = { tasks: [], members: [], projects: [] };
      if (r2Res.statusCode === 200) {
        try { data = JSON.parse(r2Res.body); } catch (e) {}
      }

      if (action === "read_tasks") {
        return res.status(200).json({
          status: "success",
          data: data.tasks,
          tasks: data.tasks
        });
      } else if (action === "read_members") {
        return res.status(200).json({
          status: "success",
          data: data.members || []
        });
      } else if (action === "read_projects") {
        return res.status(200).json({
          status: "success",
          data: data.projects || []
        });
      } else {
        // Trả về toàn bộ dữ liệu mặc định
        return res.status(200).json({
          status: "success",
          tasks: data.tasks || [],
          members: data.members || [],
          projects: data.projects || []
        });
      }
    }

    if (req.method === "POST") {
      const payload = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      const { action } = payload;
      
      const currentData = await getTasksData();

      if (action === "save_task") {
        const { id, project, deadline, issue, note, assignees, status, priority, alert_time, alert_frequency, alert_days, alert_specific_date } = payload;
        let taskStatus = "Pending";
        const rawStatus = String(status || "").trim();
        if (rawStatus.toLowerCase() === "done") {
          taskStatus = "Done";
        } else if (rawStatus === "Cố định" || rawStatus.toLowerCase() === "cố định" || rawStatus.toLowerCase() === "fixed") {
          taskStatus = "Cố định";
        } else {
          taskStatus = "Pending";
        }
        const taskPriority = ["P1","P2","P3"].includes(priority) ? priority : "P3";
        const taskAlertTime = alert_time || "09:00";
        const taskAlertFreq = ["once","1_day","3_days","1_week","2_weeks","1_month"].includes(alert_frequency)
          ? alert_frequency : "1_week";
        const validDays = ["mon","tue","wed","thu","fri","sat"];
        const taskAlertDays = (["1_week","2_weeks"].includes(taskAlertFreq) && validDays.includes(alert_days))
          ? alert_days : (["1_week","2_weeks"].includes(taskAlertFreq) ? "mon" : "");
        const taskAlertSpecificDate = (taskAlertFreq === "once") ? (alert_specific_date || "") : "";

        if (id) {
          // Edit task
          const taskIndex = currentData.tasks.findIndex(t => Number(t.id) === Number(id));
          if (taskIndex !== -1) {
            const existingTask = currentData.tasks[taskIndex];
            currentData.tasks[taskIndex] = {
              id: Number(id),
              created_at: existingTask.created_at || existingTask.id || Date.now(),
              // Preserve custom position/order set by drag-and-drop reorder
              position: existingTask.position !== undefined ? existingTask.position : taskIndex + 1,
              order: existingTask.order !== undefined ? existingTask.order : taskIndex + 1,
              project: (project || "").trim(),
              deadline: deadline || "",
              issue: issue || "",
              note: note || "",
              assignees: Array.isArray(assignees) ? assignees : [],
              status: taskStatus,
              priority: taskPriority,
              alert_time: taskAlertTime,
              alert_frequency: taskAlertFreq,
              alert_days: taskAlertDays,
              alert_specific_date: taskAlertSpecificDate
            };
          } else {
            return res.status(404).json({ status: "error", message: "Không tìm thấy task cần chỉnh sửa" });
          }
        } else {
          // Add task new
          const nowTs = Date.now();
          const newTask = {
            id: nowTs, // ID dựa trên timestamp
            created_at: nowTs,
            project: (project || "").trim(),
            deadline: deadline || "",
            issue: issue || "",
            note: note || "",
            assignees: Array.isArray(assignees) ? assignees : [],
            status: taskStatus,
            priority: taskPriority,
            alert_time: taskAlertTime,
            alert_frequency: taskAlertFreq,
            alert_days: taskAlertDays,
            alert_specific_date: taskAlertSpecificDate
          };
          currentData.tasks.push(newTask);
        }
        const savedTaskId = id ? Number(id) : currentData.tasks[currentData.tasks.length - 1].id;
        await saveTasksData(currentData);
        return res.status(200).json({ status: "success", id: savedTaskId });
      }

      if (action === "delete_task") {
        const { id } = payload;
        currentData.tasks = currentData.tasks.filter(t => String(t.id) !== String(id) && Number(t.id) !== Number(id));
        await saveTasksData(currentData);
        return res.status(200).json({ status: "success" });
      }

      if (action === "reorder_tasks") {
        const { orderedIds } = payload;
        if (Array.isArray(orderedIds)) {
          const idMap = new Map(currentData.tasks.map(t => [String(t.id), t]));
          const matchingIndices = [];
          currentData.tasks.forEach((t, idx) => {
            if (orderedIds.includes(String(t.id))) {
              matchingIndices.push(idx);
            }
          });
          orderedIds.forEach((id, i) => {
            if (matchingIndices[i] !== undefined && idMap.has(String(id))) {
              currentData.tasks[matchingIndices[i]] = idMap.get(String(id));
            }
          });
          currentData.tasks.forEach((t, idx) => {
            t.position = idx + 1;
            t.order = idx + 1;
          });
          await saveTasksData(currentData);
          return res.status(200).json({ status: "success", tasks: currentData.tasks });
        }
        return res.status(400).json({ status: "error", message: "orderedIds không hợp lệ" });
      }

      if (action === "add_member") {
        const name = (payload.name || "").trim();
        const code = (payload.code || "").trim().toUpperCase();
        if (!name) return res.status(400).json({ status: "error", message: "Tên không được để trống" });
        if (!code && payload.requireCode !== false) {
          return res.status(400).json({ status: "error", message: "Mã nhân viên không được để trống" });
        }
        
        const existsName = currentData.members.some(m => m.name.toLowerCase() === name.toLowerCase());
        if (existsName) return res.status(400).json({ status: "error", message: "Tên nhân viên đã tồn tại" });
        
        if (code) {
          const existsCode = currentData.members.some(m => (m.code || "").toUpperCase() === code);
          if (existsCode) return res.status(400).json({ status: "error", message: "Mã nhân viên đã tồn tại" });
        }

        currentData.members.push({ name, code: code || "" });
        await saveTasksData(currentData);
        return res.status(200).json({ status: "success", members: currentData.members });
      }

      if (action === "edit_member" || action === "update_member") {
        const oldName = (payload.oldName || "").trim();
        const newName = (payload.newName || payload.name || "").trim();
        const newCode = (payload.code || "").trim().toUpperCase();
        if (!oldName) return res.status(400).json({ status: "error", message: "Tên nhân viên cần sửa không hợp lệ" });
        if (!newName) return res.status(400).json({ status: "error", message: "Tên nhân viên không được để trống" });
        if (!newCode) return res.status(400).json({ status: "error", message: "Mã nhân viên là bắt buộc" });

        const idx = currentData.members.findIndex(m => m.name.toLowerCase() === oldName.toLowerCase());
        if (idx === -1) return res.status(404).json({ status: "error", message: "Không tìm thấy nhân viên: " + oldName });

        const dupName = currentData.members.some((m, i) => i !== idx && m.name.toLowerCase() === newName.toLowerCase());
        if (dupName) return res.status(400).json({ status: "error", message: "Tên nhân viên đã tồn tại" });

        const dupCode = currentData.members.some((m, i) => i !== idx && (m.code || "").toUpperCase() === newCode);
        if (dupCode) return res.status(400).json({ status: "error", message: "Mã nhân viên đã được sử dụng bởi nhân viên khác" });

        currentData.members[idx] = { name: newName, code: newCode };

        // Cập nhật tên trong assignees của các task nếu tên thay đổi
        if (oldName.toLowerCase() !== newName.toLowerCase() && Array.isArray(currentData.tasks)) {
          currentData.tasks.forEach(t => {
            if (Array.isArray(t.assignees)) {
              t.assignees = t.assignees.map(a => a.toLowerCase() === oldName.toLowerCase() ? newName : a);
            }
          });
        }

        await saveTasksData(currentData);
        return res.status(200).json({ status: "success", members: currentData.members });
      }

      if (action === "delete_member") {
        const name = (payload.name || "").trim();
        const code = (payload.code || "").trim();
        if (!name && !code) return res.status(400).json({ status: "error", message: "Tên hoặc mã nhân viên không được để trống" });
        
        const initialLen = currentData.members.length;
        currentData.members = currentData.members.filter(m => {
          if (name && m.name.toLowerCase() === name.toLowerCase()) return false;
          if (code && m.code && m.code.toLowerCase() === code.toLowerCase()) return false;
          return true;
        });
        
        if (currentData.members.length === initialLen) {
          return res.status(404).json({ status: "error", message: "Không tìm thấy nhân viên: " + (name || code) });
        }
        
        await saveTasksData(currentData);
        return res.status(200).json({ status: "success", members: currentData.members });
      }

      if (action === "add_project") {
        const name = (payload.name || "").trim();
        if (!name) return res.status(400).json({ status: "error", message: "Tên dự án không được để trống" });
        if (!currentData.projects) currentData.projects = [];
        
        const exists = currentData.projects.some(p => p.name.toLowerCase() === name.toLowerCase());
        if (exists) return res.status(400).json({ status: "error", message: "Dự án đã tồn tại" });
        
        currentData.projects.push({ name });
        await saveTasksData(currentData);
        return res.status(200).json({ status: "success" });
      }

      if (action === "delete_project") {
        const name = (payload.name || "").trim();
        if (!name) return res.status(400).json({ status: "error", message: "Tên dự án không được để trống" });
        if (!currentData.projects) currentData.projects = [];
        
        const initialLen = currentData.projects.length;
        currentData.projects = currentData.projects.filter(p => p.name.toLowerCase() !== name.toLowerCase());
        
        if (currentData.projects.length === initialLen) {
          return res.status(404).json({ status: "error", message: "Không tìm thấy dự án: " + name });
        }
        
        await saveTasksData(currentData);
        return res.status(200).json({ status: "success" });
      }

      return res.status(400).json({ status: "error", message: "Action POST không được hỗ trợ" });
    }

    return res.status(405).end("Method Not Allowed");
  } catch (err) {
    return res.status(500).json({ status: "error", message: err.message, stack: err.stack });
  }
};
