/**
 * GOOGLE APPS SCRIPT CHO BÁO CÁO OTRS TICKET TỰ ĐỘNG
 * 
 * Hướng dẫn cài đặt trên Google Apps Script:
 * 1. Mở dự án Google Apps Script của bạn (nơi chứa Web App URL hiện tại):
 *    https://script.google.com/macros/s/AKfycbxQSi9Xhn6IF5NE3bIkyQ-KbNJ8z6UG7aoqG72C-2-t9tqXY1ASHQo4Yf8RMwCTlBkX/exec
 * 2. Cập nhật / dán đoạn mã bên dưới vào file Code.gs (giữ nguyên các hàm doGet lấy số liệu email nếu có).
 * 3. Nhấn "Triển khai" (Deploy) -> "Quản lý bản triển khai" (Manage deployments).
 * 4. Bấm biểu tượng cây bút chỉnh sửa -> Phiên bản: Chọn "Phiên bản mới" (New version).
 * 5. Ai có quyền truy cập: Chọn "Bất kỳ ai" (Anyone) -> Bấm "Triển khai" (Deploy).
 */

const INPUTROW_SPREADSHEET_ID = "1Lzwt5z9xiw1C3PI7ZHQbjG23TV1zFf6kb8jYBvQvdGQ";
const INPUTROW_SHEET_GID = 114516057;

function inputRow_getSheet() {
  const spreadsheet = SpreadsheetApp.openById(INPUTROW_SPREADSHEET_ID);
  const sheets = spreadsheet.getSheets();
  for (let i = 0; i < sheets.length; i++) {
    if (sheets[i].getSheetId() === INPUTROW_SHEET_GID) {
      return sheets[i];
    }
  }
  return spreadsheet.getActiveSheet();
}

/**
 * Thêm 1 dòng vào cuối Sheet (Đủ 12 cột từ A đến L theo chuẩn Template.xlsx)
 */
function inputRow_addRow(data) {
  const sheet = inputRow_getSheet();
  const rowValues = [
    data.colA || "", // A: Date (DD/MM/YYYY)
    data.colB || "", // B: Ngày hoàn thành (DD/MM/YYYY)
    data.colC || "", // C: Dự án (NVN)
    data.colD || "", // D: Tần suất (Cố định)
    data.colE || "", // E: Kênh hỗ trợ (OTRS)
    data.colF || "", // F: Tên CV (Raise OTRS Ticket / Close OTRS Ticket / Raise ticket theo yêu cầu của HQ user)
    data.colG || "", // G: Chi tiết (Tên CV_TicketNumber_Tiêu đề)
    data.colH || "", // H: Due date (DD/MM/YYYY)
    data.colI || "", // I: Trạng thái (Done)
    data.colJ || "", // J: Mã nhân viên (tanh.h.bui.3811)
    data.colK || "", // K: Công việc cần làm (Giống Chi tiết)
    data.colL || ""  // L: Kết quả CV (Đã hoàn tất + Chi tiết)
  ];
  sheet.appendRow(rowValues);
  return { success: true, message: "Đã thêm dòng mới thành công!" };
}

/**
 * Thêm danh sách nhiều dòng vào cuối Sheet
 */
function inputRow_addRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { success: false, message: "Danh sách dòng rỗng" };
  }
  const sheet = inputRow_getSheet();
  rows.forEach(function(data) {
    const rowValues = [
      data.colA || "",
      data.colB || "",
      data.colC || "",
      data.colD || "",
      data.colE || "",
      data.colF || "",
      data.colG || "",
      data.colH || "",
      data.colI || "",
      data.colJ || "",
      data.colK || "",
      data.colL || ""
    ];
    sheet.appendRow(rowValues);
  });
  return { success: true, count: rows.length, message: "Đã thêm " + rows.length + " dòng thành công!" };
}

/**
 * Nhận yêu cầu POST từ Note Issue Studio khi nhấn "Đồng bộ R2"
 */
function doPost(e) {
  try {
    let postData = {};
    if (e && e.postData && e.postData.contents) {
      postData = JSON.parse(e.postData.contents);
    }
    const action = String(postData.action || "").toLowerCase();

    // Hỗ trợ action: input_row, add_row, addrow, otrs
    if (action === "input_row" || action === "add_row" || action === "addrow" || action === "inputrow" || action === "otrs") {
      let result;
      if (Array.isArray(postData.rows) && postData.rows.length > 0) {
        result = inputRow_addRows(postData.rows);
      } else if (postData.data) {
        result = inputRow_addRow(postData.data);
      } else {
        result = inputRow_addRow(postData);
      }
      return ContentService.createTextOutput(JSON.stringify(result))
        .setMimeType(ContentService.MimeType.JSON);
    }

    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      message: "Invalid action",
      receivedAction: postData.action || null
    })).setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      message: err.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}
