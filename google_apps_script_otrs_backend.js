/**
 * GOOGLE APPS SCRIPT KẾT HỢP CẢ 2 TÍNH NĂNG:
 * 1. doGet: Lấy số liệu Email nhận/gửi từ Sheet GID 1060225183 (Giữ nguyên 100% logic cũ của bạn)
 * 2. doPost: Thêm dòng Issue OTRS vào cuối Sheet GID 114516057 (Đầy đủ 12 cột từ A -> L theo Template.xlsx)
 * 
 * ID File Spreadsheet: 1Lzwt5z9xiw1C3PI7ZHQbjG23TV1zFf6kb8jYBvQvdGQ
 */

const SPREADSHEET_ID = "1Lzwt5z9xiw1C3PI7ZHQbjG23TV1zFf6kb8jYBvQvdGQ";
const EMAIL_SHEET_GID = 1060225183; // GID Sheet báo cáo Email
const OTRS_SHEET_GID = 114516057;   // GID Sheet ghi nhận Issue OTRS

// ==============================
// 1. GET REQUEST: LẤY SỐ LIỆU EMAIL (GIỮ NGUYÊN)
// ==============================
function doGet(e) {
  try {
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
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
// 2. POST REQUEST: THÊM DÒNG OTRS VÀO CUỐI SHEET (TỰ ĐỘNG CHỐNG TRÙNG)
// ==============================
function doPost(e) {
  try {
    let postData = {};
    if (e && e.postData && e.postData.contents) {
      postData = JSON.parse(e.postData.contents);
    }

    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const otrsSheet = ss.getSheets().find(s => s.getSheetId() === OTRS_SHEET_GID) || ss.getActiveSheet();

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
      // 12 cột từ A đến L theo chuẩn Template.xlsx
      const rowValues = [
        row.colA || "", // A: Date (DD/MM/YYYY)
        row.colB || "", // B: Ngày hoàn thành (DD/MM/YYYY)
        row.colC || "", // C: Dự án (NVN)
        row.colD || "", // D: Tần suất (Cố định)
        row.colE || "", // E: Kênh hỗ trợ (OTRS)
        row.colF || "", // F: Tên CV
        row.colG || "", // G: Chi tiết (Tên CV_TicketNumber_Tiêu đề)
        row.colH || "", // H: Due date (DD/MM/YYYY)
        row.colI || "", // I: Trạng thái (Done)
        row.colJ || "", // J: Mã nhân viên (tanh.h.bui.3811)
        row.colK || "", // K: Công việc cần làm (Giống Chi tiết)
        row.colL || ""  // L: Kết quả CV (Đã hoàn tất + Chi tiết)
      ];

      // Bỏ qua nếu dòng rỗng
      if (!rowValues.some(val => val !== "")) return;

      const gVal = String(row.colG || "").trim().toLowerCase();
      const fVal = String(row.colF || "").trim().toLowerCase();
      const m = gVal.match(/\b\d{14,18}\b/);
      const ticketNum = m ? m[0] : "";

      // Kiểm tra xem ticket này đã tồn tại trên Sheet chưa
      const isDuplicate = existingMap[gVal] || (ticketNum && (existingMap[fVal + "__" + ticketNum] || existingMap[ticketNum]));
      if (isDuplicate) {
        skippedCount++;
        return; // ĐÃ CÓ TRÊN SHEET -> BỎ QUA KHÔNG CHÈN TRÙNG!
      }

      // Thêm dòng mới vào cuối sheet
      otrsSheet.appendRow(rowValues);
      insertedCount++;

      // Ghi nhớ ngay để tránh trùng nếu trong cùng batch có dòng lặp lại
      if (gVal) existingMap[gVal] = true;
      if (ticketNum) {
        existingMap[fVal + "__" + ticketNum] = true;
        existingMap[ticketNum] = true;
      }
    });

    return jsonResponse({
      success: true,
      message: "Đã xử lý: thêm " + insertedCount + " dòng mới, bỏ qua " + skippedCount + " dòng đã tồn tại trên Sheet!",
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
// 3. JSON RESPONSE
// ==============================
function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data, null, 2))
    .setMimeType(ContentService.MimeType.JSON);
}
