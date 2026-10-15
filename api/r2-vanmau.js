try { require("dotenv").config(); } catch(_) {}
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const R2_ACCOUNT_ID        = process.env.R2_ACCOUNT_ID_DYLAN        || process.env.R2_ACCOUNT_ID        || "";
const R2_ACCESS_KEY_ID     = process.env.R2_ACCESS_KEY_ID_DYLAN     || process.env.R2_ACCESS_KEY_ID     || "";
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY_DYLAN || process.env.R2_SECRET_ACCESS_KEY || "";
const R2_BUCKET_NAME       = process.env.R2_BUCKET_NAME_DYLAN       || process.env.R2_BUCKET_NAME       || "dylan";
const R2_OBJECT_KEY        = "dms_vanmau.json";

// Dữ liệu seed mặc định ban đầu từ template/vanmau.xlsx
const DEFAULT_SEED_ITEMS = [
  {
    "id": 1,
    "english": "Dear , \n\nAccenture team has provided feedback on the ticket. Please see and verify:\n\" \"",
    "vietnamese": "Accenture team có phản hồi trên ticket này. 5S gửi anh/chị thông tin nhờ anh/chị xem qua",
    "note": "Phản hồi maill cho HQ"
  },
  {
    "id": 2,
    "english": "Install HH device",
    "vietnamese": "5S xin gửi anh/chị quy trình thực hiện trước và trong khi cài máy như sau:\n\nTrước khi cài máy mới, vui lòng lưu ý:\n\n+ DSR phải đồng bộ dữ liệu máy cũ hoặc đã gửi dữ liệu lên hệ thống.\n(Vì sau khi cài máy mới, máy cũ sẽ không thể tiếp tục sử dụng để đi bán hàng.)\n+ Trên máy mới phải có sẵn ứng dụng Quick Support (Tải trên CH Play) để 5S kết nối và hỗ trợ cài máy.\n\nKiểm tra thông tin trên ứng dụng Knox, đảm bảo đã đúng.\n\nKhi đến thời gian cài máy:\n5S sẽ chủ động liên hệ theo lịch hẹn.\n(Lưu ý: thời gian có thể thay đổi do yếu tố khách quan.)\n\nNgười đại diện:\n+ Cung cấp mã NVBH (xem trong Knox nếu cần).\n+ Mở ứng dụng Quick Support và cung cấp ID để 5S kết nối.\n\nLưu ý: Trong suốt quá trình cài đặt, vui lòng giữ màn hình sáng và luôn ở trong ứng dụng Quick Support cho đến khi 5S kết nối thành công.\n\n5S xin chân thành cảm ơn anh/chị.",
    "note": "Quy trình cài máy"
  },
  {
    "id": 3,
    "english": "Dear Accenture team,\n\nWe have updated the OTRS ticket. Please check and provide feedback.\nTicketnumber#",
    "vietnamese": "update ticket",
    "note": "Update ticekt qua mail"
  },
  {
    "id": 4,
    "english": "Waiting for feedback from HQ",
    "vietnamese": "Chờ",
    "note": "Đã gửi mail rồi sẽ waitng form HQ"
  },
  {
    "id": 5,
    "english": "",
    "vietnamese": "Em gửi anh hình ảnh screenshot thể hiện phần cập nhật thông tin CCCD và MST trên phiên bản mới của HHT. \n\nCác bước thực hiện như sau: \n- Vào phần Thông tin khách hàng \n- Kéo xuống phần Khác, sau đó chọn nút Hơn \n- Hộp thoại hiển thị thông tin bao gồm các trường để nhập và sửa: \n+ Company Tax Reg No (MST) \n+ CCCD \n+ Tax Representator (Người đại diện) \n\nThông tin sau khi nhập có thể Lưu lại để cập nhật cho khách hàng.",
    "note": ""
  },
  {
    "id": 6,
    "english": "We are confirming with the admin users and will inform you once it becomes possible",
    "vietnamese": "",
    "note": "Đang check với admin"
  },
  {
    "id": 7,
    "english": "Could you please check and update us on the status?",
    "vietnamese": "Push ACN",
    "note": "Push"
  },
  {
    "id": 8,
    "english": "5S has completely closed the ticket",
    "vietnamese": "Hoàn tất close ticket",
    "note": ""
  },
  {
    "id": 9,
    "english": "Please find the attachment with list of tickets discussed in weekly call",
    "vietnamese": "",
    "note": "Xem file đính kèm"
  },
  {
    "id": 10,
    "english": "Dear Accenture team,\n\nWe have raised the ticket on OTRS. Kindly check and provide feedback.",
    "vietnamese": "NA",
    "note": "Raise ticket qua mail"
  },
  {
    "id": 11,
    "english": "",
    "vietnamese": "Việc hiển thị vị trí bị lệch có thể do sai số GPS của thiết bị (khi sóng yếu, ở trong nhà, gần cao tầng) hoặc do bản đồ Google tại khu vực chưa khớp tuyệt đối. Đây là sai số phát sinh từ phía thiết bị/bản đồ, không phải từ hệ thống ạ. \nNếu anh/chị có vấn đề khi ghé thăm khách hàng thì vui lòng liên hệ hotline để được hỗ trợ ạ",
    "note": "Trả lời vấn đề bị lệch toạ độ khi check GG map nhưng toạ độ CH đã đúng"
  },
  {
    "id": 12,
    "english": "",
    "vietnamese": "Việc hiển thị vị trí bị lệch có thể do sai số GPS của thiết bị (khi sóng yếu, ở trong nhà, gần cao tầng) hoặc do bản đồ Google tại khu vực chưa khớp tuyệt đối. Đây là sai số phát sinh từ phía thiết bị/bản đồ, không phải từ hệ thống ạ.\nNgoài ra, việc trước đây hiển thị đúng nhưng hiện tại kiểm tra lại thấy sai có thể do điều kiện môi trường thay đổi (ví dụ: chất lượng tín hiệu GPS khác, vị trí kiểm tra ở trong nhà hoặc gần vật cản), hoặc do Google cập nhật dữ liệu bản đồ khiến tọa độ hiển thị có sự chênh lệch so với trước.",
    "note": "Trả lời vấn đề bị lệch toạ độ khi check GG map nhưng trước đây thì đúng"
  },
  {
    "id": 13,
    "english": "",
    "vietnamese": "Dạ anh/chị, để kiểm tra và ghi nhận chính xác vấn đề này, 5S cần phải kết nối trực tiếp vào thiết bị tại thời điểm DSR thực hiện mở mới cửa hiệu.\nNhờ các anh/chị ASM khi có trường hợp mở mới KH thì báo DSR liên hệ ngay cho 5S để kết nối kiểm tra, đồng thời 5S sẽ quay lại video thao tác và gửi cho bộ phận kỹ thuật xử lý ạ.\n5S xin cảm ơn ạ.",
    "note": "Trả lời vấn đề khi có người báo lên Issue khi không có hình ảnh hay video chứng minh"
  },
  {
    "id": 14,
    "english": "kết nối quicksupport",
    "vietnamese": "Tiếng Việt: \"Dạ mình chọn \"\"Xác minh người dùng\"\" -> chọn ô vuông trước \"\"\nTôi muốn cho phép truy cập\"\" -> \"\"Cho phép\"\" -> \"\"Bắt đầu ngay\"\"\n--------------------------------------------------------------------------------------\nTiếng Anh cho người Việt: Chọn “Verify User” → tích vào ô vuông “I trust this person and allow immediate access to my device” → nhấp vào “Allow access” → sau đó chọn “Start now.”\n---------------------------------------------------------------------------------------\nTiếng anh: Select “Verify User” → check the box “I trust this person and allow immediate access to my device” → click “Allow access” → then select “Start now.”",
    "note": "Link: 0.Step-by-Step Guide on TeamViewer QuickSupport.docx"
  },
  {
    "id": 15,
    "english": "",
    "vietnamese": "Dạ đối với các ứng dụng ngoài hệ thống DMS, 5S không hỗ trợ được do không quản lý tính năng của các ứng dụng này. Nhờ anh/chị liên hệ về công ty để được hỗ trợ chi tiết ạ",
    "note": "Trả lời cho các app ngoài dms"
  },
  {
    "id": 16,
    "english": "Lỗi không truy cập được server - hệ thống không hoạt động",
    "vietnamese": "Dear @All Anh/Chị ASM, \n5S đã nhận thông tin trường hợp không đồng bộ được hoặc không vào được ứng dụng. \n5S đã báo kỹ thuật kiểm tra, khi có phản hồi 5S sẽ thông báo đến Anh/Chị ạ\nXin cảm ơn ạ\n\nDear @All Anh/Chị ASM,\n\nHiện tại, vấn đề không thể kết nối đến sever. 5S đã gửi cho kỹ thuật kiểm tra, 5S sẽ thông báo cho anh/chị sớm khi có kết quả ạ. Nhờ anh/chị thông báo đến DSR giúp 5S ạ\n\n5S xin cảm ơn!\n\nDear @All,\nDạ hiện tại đã đồng bộ bình thường, nhờ anh/chị báo DSR thoát ra và đồng bộ lại giúp 5S ạ. \n5S xin cảm ơn!\n\nDear @All Anh/Chị,\nDạ hiện tại hệ thống đã hoạt động bình thường, nhờ anh/chị thử lại giúp 5S ạ. \n5S xin cảm ơn!",
    "note": "Cannot connect to seser"
  },
  {
    "id": 17,
    "english": "Locked OTP",
    "vietnamese": "Dear Anh/Chị, \n5S kiểm tra thì thấy máy bị khoá do xác minh sai Face ID/OTP ạ, nhờ anh gửi mail cho anh Mới để được hỗ trợ mở khoá ạ. 5S xin cảm ơn!",
    "note": "Khoá OTP"
  },
  {
    "id": 18,
    "english": "NA",
    "vietnamese": "Dạ đối với ứng dụng chụp ảnh AI Field V3 pro, nhờ anh/chị liên hệ về hotline của Nestle để được hỗ trợ ạ. 5S xin cảm ơn ạ!",
    "note": "V3 pro"
  },
  {
    "id": 19,
    "english": "NA",
    "vietnamese": "Dạ do Face ID hiện không nhận điện được khuôn mặt nhờ anh chị dùng tạm tính năng lấy OTP giúp 5S ạ\nMình bấm Get OTP 1 lần duy nhất rồi liên hệ Admin để lấy mã OTP\nTránh nhập sai nhiều lần gây khoá máy ạ\n\nTrong trường hợp máy bị khoá nhờ anh/chị ASM liên hệ anh Mới để mở khoá và liên hệ 5S để được hướng dẫn thao tác ạ\n5S xin cảm ơn",
    "note": ""
  }
];

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

// Đọc danh sách văn mẫu từ R2 (nếu 404 thì khởi tạo với DEFAULT_SEED_ITEMS)
async function getVanMauData() {
  const r2Res = await r2Fetch("GET", "");
  if (r2Res.statusCode === 200) {
    try {
      const parsed = JSON.parse(r2Res.body);
      const items = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.data) ? parsed.data : []);
      return {
        data: items,
        etag: r2Res.headers["etag"] || r2Res.headers["ETag"] || "",
        updatedAt: parsed.updatedAt || Date.now()
      };
    } catch (_) {}
  }

  // Nếu chưa có trên R2 (404), tự động lưu seed ban đầu lên R2
  const seedPayload = {
    status: "success",
    data: DEFAULT_SEED_ITEMS,
    updatedAt: Date.now()
  };
  try {
    const putRes = await r2Fetch("PUT", JSON.stringify(seedPayload));
    return {
      data: DEFAULT_SEED_ITEMS,
      etag: putRes.headers["etag"] || putRes.headers["ETag"] || "",
      updatedAt: seedPayload.updatedAt
    };
  } catch (err) {
    console.warn("Lỗi auto-seed R2 văn mẫu:", err.message);
    return {
      data: DEFAULT_SEED_ITEMS,
      etag: "",
      updatedAt: seedPayload.updatedAt
    };
  }
}

// Lưu toàn bộ danh sách văn mẫu lên R2
async function saveVanMauData(items) {
  const payload = {
    status: "success",
    data: items,
    updatedAt: Date.now()
  };
  const putRes = await r2Fetch("PUT", JSON.stringify(payload));
  if (putRes.statusCode >= 200 && putRes.statusCode < 300) {
    return {
      status: "success",
      data: items,
      etag: putRes.headers["etag"] || putRes.headers["ETag"] || "",
      updatedAt: payload.updatedAt
    };
  }
  throw new Error(`R2 PUT failed HTTP ${putRes.statusCode}: ${putRes.body}`);
}

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,HEAD,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, If-Match, If-None-Match, Pragma, Cache-Control, X-Requested-With",
  "Access-Control-Expose-Headers": "ETag, Last-Modified",
  "Access-Control-Allow-Private-Network": "true"
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
    // HEAD method (kiểm tra ETag / thay đổi nhanh)
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

    // Parse query params
    const parsedUrl = require("url").parse(req.url, true);
    const query = parsedUrl.query || {};

    // GET method: Đọc dữ liệu hoặc xử lý action qua GET fallback
    if (req.method === "GET") {
      const action = query.action;
      
      // Hỗ trợ GET Fallback cho create / update / delete khi mạng chặn POST
      if (action && action !== "read") {
        let payload = null;
        if (query.data) {
          try { payload = JSON.parse(decodeURIComponent(query.data)); } catch(_) {}
        }
        if (!payload) payload = query;

        return await handleAction(action, payload, res);
      }

      // Đọc toàn bộ danh sách
      const { data, etag, updatedAt } = await getVanMauData();
      if (etag) res.setHeader("ETag", etag);
      return res.status(200).json({
        status: "success",
        data: data,
        count: data.length,
        updatedAt: updatedAt
      });
    }

    // POST / PUT method: Xử lý Thêm / Sửa / Xóa / Lưu toàn bộ
    if (req.method === "POST" || req.method === "PUT") {
      let payload = req.body;
      if (typeof payload === "string") {
        try { payload = JSON.parse(payload); } catch (_) {}
      }
      if (!payload || typeof payload !== "object") {
        return res.status(400).json({ status: "error", message: "Payload không hợp lệ" });
      }

      const action = payload.action || (req.method === "PUT" ? "update" : "create");
      return await handleAction(action, payload, res);
    }

    // DELETE method: Xóa theo ID
    if (req.method === "DELETE") {
      const id = query.id || (req.body && req.body.id);
      if (!id) {
        return res.status(400).json({ status: "error", message: "Thiếu ID câu văn mẫu cần xóa" });
      }
      return await handleAction("delete", { id: id }, res);
    }

    return res.status(405).json({ status: "error", message: "Method not allowed" });

  } catch (err) {
    console.error("Lỗi API r2-vanmau:", err);
    return res.status(500).json({
      status: "error",
      message: err.message || "Lỗi máy chủ nội bộ"
    });
  }
};

// Hàm xử lý chung các hành động CRUD
async function handleAction(action, payload, res) {
  const current = await getVanMauData();
  const list = [...(current.data || [])];
  const nowTs = Date.now();

  // 1. Thêm mới câu văn mẫu (CREATE)
  if (action === "create" || action === "add") {
    const english = String(payload.english || "").trim();
    const vietnamese = String(payload.vietnamese || "").trim();
    const note = String(payload.note || "").trim();

    if (!english && !vietnamese) {
      return res.status(400).json({ status: "error", message: "Vui lòng nhập ít nhất nội dung Tiếng Anh hoặc Tiếng Việt" });
    }

    // Tạo ID mới: lấy max ID hiện tại + 1 hoặc dùng timestamp
    let maxId = 0;
    list.forEach(item => {
      const num = Number(item.id);
      if (!isNaN(num) && num > maxId) maxId = num;
    });
    const newId = maxId > 0 ? (maxId + 1) : nowTs;

    const newItem = {
      id: newId,
      english: english,
      vietnamese: vietnamese,
      note: note,
      createdAt: nowTs,
      updatedAt: nowTs
    };

    // Đưa câu mới lên đầu bảng hoặc cuối bảng (thêm vào đầu để người dùng dễ thấy ngay)
    list.unshift(newItem);
    await saveVanMauData(list);

    return res.status(200).json({
      status: "success",
      message: "Thêm mới câu văn mẫu thành công",
      data: newItem,
      allData: list
    });
  }

  // 2. Chỉnh sửa câu văn mẫu (UPDATE)
  if (action === "update" || action === "edit") {
    const id = payload.id;
    if (id === undefined || id === null || id === "") {
      return res.status(400).json({ status: "error", message: "Thiếu ID câu văn mẫu cần cập nhật" });
    }

    const index = list.findIndex(item => String(item.id) === String(id));
    if (index === -1) {
      return res.status(404).json({ status: "error", message: `Không tìm thấy câu văn mẫu có ID ${id}` });
    }

    const existing = list[index];
    const english = payload.english !== undefined ? String(payload.english).trim() : existing.english;
    const vietnamese = payload.vietnamese !== undefined ? String(payload.vietnamese).trim() : existing.vietnamese;
    const note = payload.note !== undefined ? String(payload.note).trim() : existing.note;

    if (!english && !vietnamese) {
      return res.status(400).json({ status: "error", message: "Vui lòng nhập ít nhất nội dung Tiếng Anh hoặc Tiếng Việt" });
    }

    list[index] = {
      ...existing,
      english: english,
      vietnamese: vietnamese,
      note: note,
      updatedAt: nowTs
    };

    await saveVanMauData(list);

    return res.status(200).json({
      status: "success",
      message: "Cập nhật câu văn mẫu thành công",
      data: list[index],
      allData: list
    });
  }

  // 3. Xóa câu văn mẫu (DELETE)
  if (action === "delete" || action === "remove") {
    const id = payload.id;
    if (id === undefined || id === null || id === "") {
      return res.status(400).json({ status: "error", message: "Thiếu ID câu văn mẫu cần xóa" });
    }

    const initialLen = list.length;
    const updatedList = list.filter(item => String(item.id) !== String(id));

    if (updatedList.length === initialLen) {
      return res.status(404).json({ status: "error", message: `Không tìm thấy câu văn mẫu có ID ${id} để xóa` });
    }

    await saveVanMauData(updatedList);

    return res.status(200).json({
      status: "success",
      message: "Đã xóa câu văn mẫu thành công",
      deletedId: id,
      allData: updatedList
    });
  }

  // 4. Lưu toàn bộ danh sách (SAVE_ALL / SYNC_ALL)
  if (action === "save_all" || action === "sync_all" || action === "import") {
    const items = Array.isArray(payload.data) ? payload.data : (Array.isArray(payload.templates) ? payload.templates : null);
    if (!Array.isArray(items)) {
      return res.status(400).json({ status: "error", message: "Dữ liệu danh sách không hợp lệ" });
    }

    await saveVanMauData(items);

    return res.status(200).json({
      status: "success",
      message: `Đã lưu toàn bộ ${items.length} câu văn mẫu lên Cloud R2`,
      data: items
    });
  }

  return res.status(400).json({ status: "error", message: `Hành động '${action}' không được hỗ trợ` });
}
