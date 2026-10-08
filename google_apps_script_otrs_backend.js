/**
 * GOOGLE APPS SCRIPT KẾT HỢP CẢ 2 TÍNH NĂNG:
 * 1. doGet: Lấy số liệu Email nhận/gửi từ Sheet GID 1060225183 (Giữ nguyên 100% logic cũ)
 *    - Hỗ trợ thêm tham số ?action=fix_dates để tự động quét & sửa toàn bộ ngày cũ về dd/MM/yyyy
 * 2. doPost: Thêm dòng Issue OTRS vào cuối Sheet GID 114516057 (Đầy đủ 12 cột từ A -> L theo Template.xlsx)
 *    - ĐẢM BẢO CHUẨN ĐỊNH DẠNG NGÀY dd/MM/yyyy (Không bao giờ bị Google Sheets đảo thành mm/dd/yyyy)
 * 
 * ID File Spreadsheet: 1Lzwt5z9xiw1C3PI7ZHQbjG23TV1zFf6kb8jYBvQvdGQ
 */

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

    // 1. Quét danh sách các Ticket / Chi tiết đã có sẵn trên Sheet để chống trùng lặp tuyệt đối
    const lastRow = otrsSheet.getLastRow();
    const existingMap = {};
    if (lastRow > 1) {
      // Đọc từ cột F (Tên CV) và G (Chi tiết) từ dòng 2
      const existingData = otrsSheet.getRange(2, 6, lastRow - 1, 2).getValues();
      for (let i = 0; i < existingData.length; i++) {
        const cv = String(existingData[i][0] || "").trim().toLowerCase();
        const detail = String(existingData[i][1] || "").trim().toLowerCase();
        if (detail) existingMap[detail] = true;
        const m = detail.match(/\b\d{14,18}\b/);
        if (m) {
          existingMap[cv + "__" + m[0]] = true;
          existingMap[m[0]] = true; // Lưu mã số ticket thuần
        }
      }
    }

    // Hỗ trợ cả mảng rows hoặc 1 dòng đơn lẻ (data / postData)
    const rowsToAdd = Array.isArray(postData.rows) && postData.rows.length > 0 
      ? postData.rows 
      : (postData.data ? [postData.data] : [postData]);

    let insertedCount = 0;
    let skippedCount = 0;

    rowsToAdd.forEach(function(row) {
      const gVal = String(row.colG || "").trim().toLowerCase();
      const fVal = String(row.colF || "").trim().toLowerCase();
      const m = gVal.match(/\b\d{14,18}\b/);
      const ticketNum = m ? m[0] : (row.ticketNum || "");

      // Kiểm tra xem ticket này đã tồn tại trên Sheet chưa
      const isDuplicate = existingMap[gVal] || (ticketNum && (existingMap[fVal + "__" + ticketNum] || existingMap[ticketNum]));
      if (isDuplicate) {
        skippedCount++;
        return; // ĐÃ CÓ TRÊN SHEET -> BỎ QUA KHÔNG CHÈN TRÙNG!
      }

      // 2. Chuyển đổi chính xác sang Date Object chuẩn (Ngày/Tháng/Năm không bị tráo đổi)
      const dateCellA = parseDateForCell(row.colA, row.dateParts, row.isoDate, ticketNum);
      const dateCellB = parseDateForCell(row.colB, row.dateParts, row.isoDate, ticketNum);
      const dateCellH = parseDateForCell(row.colH, row.dateParts, row.isoDate, ticketNum);

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
      } catch (_) {}

      // Ghi nhớ ngay để tránh trùng nếu trong cùng batch có dòng lặp lại
      if (gVal) existingMap[gVal] = true;
      if (ticketNum) {
        existingMap[fVal + "__" + ticketNum] = true;
        existingMap[ticketNum] = true;
      }
    });

    // Tự động kiểm tra & chuẩn hóa lại các dòng cũ bị lỗi format nếu có
    if (insertedCount > 0) {
      try {
        fixDatesOnSheet(otrsSheet);
      } catch (_) {}
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
function parseDateForCell(val, dateParts, isoDate, ticketNum) {
  // 1. Ưu tiên lấy từ mã Ticket OTRS (14-18 số dạng YYYYMMDD... ví dụ 2026100855000208)
  // Đây là nguồn chính xác 100% từ chính hệ thống OTRS
  if (ticketNum && /^\d{14,18}$/.test(ticketNum)) {
    const y = parseInt(ticketNum.slice(0, 4), 10);
    const m = parseInt(ticketNum.slice(4, 6), 10);
    const d = parseInt(ticketNum.slice(6, 8), 10);
    if (y >= 2020 && y <= 2040 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return new Date(y, m - 1, d, 12, 0, 0); // 12:00 trưa để không bị lệch múi giờ
    }
  }

  // 2. Nếu có dateParts { day, month, year } từ client
  if (dateParts && dateParts.year && dateParts.month && dateParts.day) {
    const y = parseInt(dateParts.year, 10);
    const m = parseInt(dateParts.month, 10) - 1;
    const d = parseInt(dateParts.day, 10);
    return new Date(y, m, d, 12, 0, 0);
  }

  // 3. Nếu có isoDate (YYYY-MM-DD)
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

  // 4. Chuỗi dạng dd/MM/yyyy hoặc d/M/yyyy (Ngày đứng trước, tháng đứng sau theo chuẩn Việt Nam)
  const dmyMatch = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dmyMatch) {
    const d = parseInt(dmyMatch[1], 10);
    const m = parseInt(dmyMatch[2], 10) - 1;
    const y = parseInt(dmyMatch[3], 10);
    return new Date(y, m, d, 12, 0, 0);
  }

  // 5. Chuỗi dạng YYYY-MM-DD hoặc YYYY/MM/DD
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
// 4. HÀM QUÉT & SỬA TOÀN BỘ CÁC DÒNG CŨ BỊ LỖI NGÀY / FORMAT TRÊN SHEET
// ==============================
function fixDatesOnSheet(otrsSheet) {
  const lastRow = otrsSheet.getLastRow();
  if (lastRow < 2) return 0;

  // Đọc từ dòng 2: cột A đến H (8 cột)
  const range = otrsSheet.getRange(2, 1, lastRow - 1, 8);
  const values = range.getValues();
  let fixedCount = 0;

  for (let i = 0; i < values.length; i++) {
    const rowIdx = i + 2;
    const detail = String(values[i][6] || "").trim(); // Cột G (Chi tiết)
    
    // Tìm mã ticket OTRS (14 - 18 chữ số dạng YYYYMMDD...)
    const m = detail.match(/\b\d{14,18}\b/);
    if (m) {
      const ticketNum = m[0];
      const y = parseInt(ticketNum.slice(0, 4), 10);
      const mNum = parseInt(ticketNum.slice(4, 6), 10);
      const d = parseInt(ticketNum.slice(6, 8), 10);

      if (y >= 2020 && y <= 2040 && mNum >= 1 && mNum <= 12 && d >= 1 && d <= 31) {
        const correctDate = new Date(y, mNum - 1, d, 12, 0, 0);

        // Ghi lại Date object đúng và set format dd/MM/yyyy
        otrsSheet.getRange(rowIdx, 1).setValue(correctDate).setNumberFormat("dd/MM/yyyy").setHorizontalAlignment("center");
        otrsSheet.getRange(rowIdx, 2).setValue(correctDate).setNumberFormat("dd/MM/yyyy").setHorizontalAlignment("center");
        otrsSheet.getRange(rowIdx, 8).setValue(correctDate).setNumberFormat("dd/MM/yyyy").setHorizontalAlignment("center");
        fixedCount++;
      }
    }
  }

  // Đảm bảo toàn bộ cột A, B, H từ dòng 2 đều có format dd/MM/yyyy
  try {
    otrsSheet.getRange(2, 1, lastRow - 1, 1).setNumberFormat("dd/MM/yyyy");
    otrsSheet.getRange(2, 2, lastRow - 1, 1).setNumberFormat("dd/MM/yyyy");
    otrsSheet.getRange(2, 8, lastRow - 1, 1).setNumberFormat("dd/MM/yyyy");
  } catch (_) {}

  return fixedCount;
}

// ==============================
// 5. JSON RESPONSE
// ==============================
function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data, null, 2))
    .setMimeType(ContentService.MimeType.JSON);
}
