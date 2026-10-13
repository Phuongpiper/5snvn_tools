
const SPREADSHEET_ID = "1Lzwt5z9xiw1C3PI7ZHQbjG23TV1zFf6kb8jYBvQvdGQ";
const EMAIL_SHEET_GID = 1060225183; // GID Sheet báo cáo Email
const OTRS_SHEET_GID = 114516057;   // GID Sheet ghi nhận Issue OTRS

// ==============================
// 1. GET REQUEST: LẤY SỐ LIỆU EMAIL HOẶC SỬA NHANH ĐỊNH DẠNG NGÀY
// ==============================
function doGet(e) {
  try {
    const params = (e && e.parameter) || {};
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);

    // HỖ TRỢ ACTION SỬA NHANH ĐỊNH DẠNG NGÀY TRỰC TIẾP TRÊN TRÌNH DUYỆT: ?action=fix_dates
    if (params.action === "fix_dates" || params.action === "fix_date") {
      const otrsSheet = ss.getSheets().find(s => s.getSheetId() === OTRS_SHEET_GID) || ss.getActiveSheet();
      const fixedCount = fixDatesOnSheet(otrsSheet);
      return jsonResponse({
        success: true,
        message: "Đã chuẩn hóa định dạng ngày dd/MM/yyyy cho " + fixedCount + " dòng OTRS trên Google Sheet!",
        fixedCount: fixedCount
      });
    }

    // MẶC ĐỊNH: LẤY SỐ LIỆU EMAIL (GIỮ NGUYÊN 100%)
    const sheet = ss.getSheets().find(s => s.getSheetId() === EMAIL_SHEET_GID);
    if (!sheet) {
      return jsonResponse({
        success: false,
        error: "Không tìm thấy sheet GID: " + EMAIL_SHEET_GID
      });
    }

    // LẤY NGÀY TỪ Ô C2
    const c2Value = sheet.getRange("C2").getValue();
    let date = "";

    if (c2Value instanceof Date && !isNaN(c2Value)) {
      date = Utilities.formatDate(
        c2Value,
        ss.getSpreadsheetTimeZone(),
        "yyyy-MM-dd"
      );
    } else if (c2Value) {
      const text = String(c2Value).trim();
      date = text.split(" ")[0];
    }

    // LẤY SỐ MAIL NHẬN / GỬI
    const lastRow = sheet.getLastRow();
    let received = 0;
    let sent = 0;
    let total = 0;

    if (lastRow > 0) {
      const data = sheet.getRange(1, 9, lastRow, 2).getDisplayValues();

      data.forEach(row => {
        const type = String(row[0]).trim().toLowerCase();
        const count = Number(String(row[1]).replace(/,/g, "")) || 0;

        if (type === "nhận" || type === "nhan") received = count;
        if (type === "gửi" || type === "gui") sent = count;
        if (type === "tổng" || type === "tong") total = count;
      });
    }

    return jsonResponse({
      success: true,
      date: date,
      total: total,
      received: received,
      sent: sent
    });

  } catch (error) {
    return jsonResponse({
      success: false,
      error: error.message
    });
  }
}

// ==============================
// 2. POST REQUEST: THÊM DÒNG OTRS VÀO CUỐI SHEET (CHỐNG TRÙNG & CHUẨN dd/MM/yyyy)
// ==============================
function doPost(e) {
  try {
    let postData = {};
    if (e && e.postData && e.postData.contents) {
      postData = JSON.parse(e.postData.contents);
    }

    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const otrsSheet = ss.getSheets().find(s => s.getSheetId() === OTRS_SHEET_GID) || ss.getActiveSheet();

    // HỖ TRỢ ACTION SỬA TOÀN BỘ NGÀY CŨ TRÊN SHEET
    if (postData.action === "fix_dates" || postData.fixExistingDates) {
      const fixedCount = fixDatesOnSheet(otrsSheet);
      return jsonResponse({
        success: true,
        message: "Đã chuẩn hóa định dạng ngày dd/MM/yyyy cho " + fixedCount + " dòng OTRS trên Google Sheet!",
        fixedCount: fixedCount
      });
    }

    // 1. Quét danh sách các Ticket / Chi tiết đã có sẵn trên Sheet theo từng ngày
    // QUY TẮC: Chỉ chặn trùng khi CÙNG NGÀY đã có ticket này. 
    // Tuyệt đối không chặn các ticket lặp lại (Recurring) hoặc ticket từ các tháng/ngày trước được nhân viên xử lý lại hôm nay!
    const lastRow = otrsSheet.getLastRow();
    const existingMap = {};
    if (lastRow > 1) {
      // Đọc từ cột A (Date: col 1) đến cột G (Chi tiết: col 7)
      const existingData = otrsSheet.getRange(2, 1, lastRow - 1, 7).getValues();
      for (let i = 0; i < existingData.length; i++) {
        const rawDate = existingData[i][0];
        let dateStr = "";
        if (rawDate instanceof Date && !isNaN(rawDate)) {
          dateStr = Utilities.formatDate(rawDate, ss.getSpreadsheetTimeZone() || "GMT+7", "dd/MM/yyyy");
        } else if (rawDate) {
          dateStr = String(rawDate).trim().split(" ")[0];
        }

        const cv = String(existingData[i][5] || "").trim().toLowerCase(); // Cột F: Tên CV
        const detail = String(existingData[i][6] || "").trim().toLowerCase(); // Cột G: Chi tiết
        const m = detail.match(/\b\d{14,18}\b/);
        const tNum = m ? m[0] : "";

        if (dateStr && detail) {
          existingMap[dateStr + "__" + detail] = true;
        }
        if (dateStr && tNum) {
          existingMap[dateStr + "__" + tNum] = true;
          existingMap[dateStr + "__" + cv + "__" + tNum] = true;
        }
      }
    }

    // Hỗ trợ cả mảng rows hoặc 1 dòng đơn lẻ (data / postData)
    const rowsToAdd = Array.isArray(postData.rows) && postData.rows.length > 0
      ? postData.rows
      : (postData.data ? [postData.data] : [postData]);

    let insertedCount = 0;
    let skippedCount = 0;

    rowsToAdd.forEach(function (row) {
      const gVal = String(row.colG || "").trim().toLowerCase();
      const fVal = String(row.colF || "").trim().toLowerCase();
      const m = gVal.match(/\b\d{14,18}\b/);
      const ticketNum = m ? m[0] : (row.ticketNum || "");
      const dateAStr = String(row.colA || "").trim();

      // Kiểm tra xem ticket này đã tồn tại trên Sheet trong CÙNG NGÀY chưa
      const isDuplicateToday = Boolean(dateAStr && (
        existingMap[dateAStr + "__" + gVal] ||
        (ticketNum && existingMap[dateAStr + "__" + ticketNum]) ||
        (ticketNum && existingMap[dateAStr + "__" + fVal + "__" + ticketNum])
      ));

      if (isDuplicateToday && !postData.force) {
        skippedCount++;
        return; // ĐÃ CÓ TRÊN SHEET TRONG CÙNG NGÀY -> BỎ QUA KHÔNG CHÈN TRÙNG!
      }

      // 2. Chuyển đổi chính xác sang Date Object chuẩn (Ngày/Tháng/Năm không bị tráo đổi)
      const dateCellA = parseDateForCell(row.colA, row.dateParts, row.isoDate);
      const dateCellB = parseDateForCell(row.colB, row.dateParts, row.isoDate);
      const dateCellH = parseDateForCell(row.colH, row.dateParts, row.isoDate);

      // 12 cột từ A đến L theo chuẩn Template.xlsx
      const rowValues = [
        dateCellA,      // A: Date (dd/MM/yyyy)
        dateCellB,      // B: Ngày hoàn thành (dd/MM/yyyy)
        row.colC || "", // C: Dự án (NVN)
        row.colD || "", // D: Tần suất (Cố định)
        row.colE || "", // E: Kênh hỗ trợ (OTRS)
        row.colF || "", // F: Tên CV
        row.colG || "", // G: Chi tiết (Tên CV_TicketNumber_Tiêu đề)
        dateCellH,      // H: Due date (dd/MM/yyyy)
        row.colI || "", // I: Trạng thái (Done)
        row.colJ || "", // J: Mã nhân viên (tanh.h.bui.3811)
        row.colK || "", // K: Công việc cần làm (Giống Chi tiết)
        row.colL || ""  // L: Kết quả CV (Đã hoàn tất + Chi tiết)
      ];

      // Bỏ qua nếu dòng rỗng
      if (!rowValues.some(val => val !== "")) return;

      // Thêm dòng mới vào cuối sheet
      otrsSheet.appendRow(rowValues);
      insertedCount++;

      // Định dạng ngày hiển thị chuẩn dd/MM/yyyy và căn giữa cho các cột A, B, H
      const newRowIdx = otrsSheet.getLastRow();
      try {
        otrsSheet.getRange(newRowIdx, 1).setNumberFormat("dd/MM/yyyy").setHorizontalAlignment("center");
        otrsSheet.getRange(newRowIdx, 2).setNumberFormat("dd/MM/yyyy").setHorizontalAlignment("center");
        otrsSheet.getRange(newRowIdx, 8).setNumberFormat("dd/MM/yyyy").setHorizontalAlignment("center");
      } catch (_) { }

      // Ghi nhớ ngay để tránh trùng nếu trong cùng batch có dòng lặp lại
      if (dateAStr && gVal) existingMap[dateAStr + "__" + gVal] = true;
      if (dateAStr && ticketNum) {
        existingMap[dateAStr + "__" + ticketNum] = true;
        existingMap[dateAStr + "__" + fVal + "__" + ticketNum] = true;
      }
    });

    // Tự động kiểm tra & chuẩn hóa lại format dd/MM/yyyy cho các cột ngày nếu có
    if (insertedCount > 0) {
      try {
        fixDatesOnSheet(otrsSheet);
      } catch (_) { }
    }

    return jsonResponse({
      success: true,
      message: "Đã xử lý: thêm " + insertedCount + " dòng mới (chuẩn dd/MM/yyyy), bỏ qua " + skippedCount + " dòng đã tồn tại trên Sheet!",
      insertedCount: insertedCount,
      skippedCount: skippedCount
    });

  } catch (error) {
    return jsonResponse({
      success: false,
      error: error.message
    });
  }
}

// ==============================
// 3. HÀM CHUYỂN ĐỔI NGÀY SANG DATE OBJECT CHUẨN (ĐẢM BẢO ĐÚNG dd/MM/yyyy)
// ==============================
function parseDateForCell(val, dateParts, isoDate) {
  // 1. Ưu tiên dateParts { day, month, year } từ client (ngày thực tế nhân viên ghi nhận Issue)
  if (dateParts && dateParts.year && dateParts.month && dateParts.day) {
    const y = parseInt(dateParts.year, 10);
    const m = parseInt(dateParts.month, 10) - 1;
    const d = parseInt(dateParts.day, 10);
    if (!isNaN(y) && !isNaN(m) && !isNaN(d)) {
      return new Date(y, m, d, 12, 0, 0); // 12:00 trưa để không bị lệch múi giờ
    }
  }

  // 2. Nếu có isoDate (YYYY-MM-DD)
  if (isoDate && /^\d{4}-\d{2}-\d{2}$/.test(String(isoDate).trim())) {
    const p = String(isoDate).trim().split("-");
    const y = parseInt(p[0], 10);
    const m = parseInt(p[1], 10) - 1;
    const d = parseInt(p[2], 10);
    return new Date(y, m, d, 12, 0, 0);
  }

  if (!val) return "";
  if (val instanceof Date) return val;

  const str = String(val).trim();
  if (!str) return "";

  // 3. Chuỗi dạng dd/MM/yyyy hoặc d/M/yyyy (Ngày đứng trước, tháng đứng sau theo chuẩn Việt Nam)
  const dmyMatch = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dmyMatch) {
    const d = parseInt(dmyMatch[1], 10);
    const m = parseInt(dmyMatch[2], 10) - 1;
    const y = parseInt(dmyMatch[3], 10);
    return new Date(y, m, d, 12, 0, 0);
  }

  // 4. Chuỗi dạng YYYY-MM-DD hoặc YYYY/MM/DD
  const ymdMatch = str.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/);
  if (ymdMatch) {
    const y = parseInt(ymdMatch[1], 10);
    const m = parseInt(ymdMatch[2], 10) - 1;
    const d = parseInt(ymdMatch[3], 10);
    return new Date(y, m, d, 12, 0, 0);
  }

  return str;
}

// ==============================
// 4. HÀM CHUẨN HÓA ĐỊNH DẠNG NGÀY CHO CÁC CỘT TRÊN SHEET (KHÔNG GHI ĐÈ GIÁ TRỊ)
// ==============================
function fixDatesOnSheet(otrsSheet) {
  const lastRow = otrsSheet.getLastRow();
  if (lastRow < 2) return 0;

  // Đảm bảo toàn bộ cột A, B, H từ dòng 2 đều có format dd/MM/yyyy và căn giữa
  // TUYỆT ĐỐI KHÔNG dùng mã ticket OTRS ghi đè ngày công việc của nhân viên
  try {
    otrsSheet.getRange(2, 1, lastRow - 1, 1).setNumberFormat("dd/MM/yyyy").setHorizontalAlignment("center");
    otrsSheet.getRange(2, 2, lastRow - 1, 1).setNumberFormat("dd/MM/yyyy").setHorizontalAlignment("center");
    otrsSheet.getRange(2, 8, lastRow - 1, 1).setNumberFormat("dd/MM/yyyy").setHorizontalAlignment("center");
  } catch (_) { }

  return 0;
}

// ==============================
// 5. JSON RESPONSE
// ==============================
function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data, null, 2))
    .setMimeType(ContentService.MimeType.JSON);
}
