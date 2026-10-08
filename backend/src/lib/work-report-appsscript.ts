// F36: sinh đoạn mã Apps Script dán vào trang tính của nhân viên.
//
// Vì sao sinh ở backend chứ không để người dùng tự sửa một tệp mẫu: URL CRM và
// token là hai thứ dán sai là im lặng không chạy. Sinh sẵn thì người gắn trang
// tính chỉ việc copy - paste - bấm setup().
//
// Script làm ba việc:
//   1. setup()         — lưu URL + token vào Script Properties, cài hai trigger,
//                        rồi đẩy luôn một lần cho người dùng thấy kết quả ngay.
//   2. onSheetEdit()   — trigger onEdit, CHỈ đánh dấu "có sửa" (không gọi mạng:
//                        onEdit chạy mỗi lần gõ, gọi mạng ở đây là tự chặn mình
//                        bằng quota UrlFetch của Google).
//   3. flushChanges()  — trigger 5 phút, có dấu "có sửa" thì đẩy tháng hiện tại;
//                        thêm một trigger 2 giờ đẩy TOÀN BỘ 12 tháng để không
//                        bao giờ lệch dần (sửa tháng cũ, xoá dòng, đổi tên sheet).

export interface AppsScriptOptions {
  baseUrl: string;
  token: string;
  /** Hiện trong lời chú thích để người dán biết mã này của ai. */
  employeeName?: string | null;
  spreadsheetTitle?: string | null;
}

/** Nhúng chuỗi vào mã JS an toàn (token là base64url nên thực tế vô hại, vẫn thoát cho chắc). */
function js(value: string): string {
  return JSON.stringify(String(value ?? ""));
}

export function renderAppsScript(opts: AppsScriptOptions): string {
  const endpoint = `${opts.baseUrl.replace(/\/+$/, "")}/api/work-reports/ingest`;
  const who = opts.employeeName ? ` — ${opts.employeeName}` : "";
  const title = opts.spreadsheetTitle ? ` (${opts.spreadsheetTitle})` : "";

  return `/**
 * CRM Louva — đẩy báo cáo công việc hàng ngày về CRM${who}${title}
 *
 * CÁCH DÙNG (làm một lần cho mỗi trang tính):
 *   1. Mở trang tính này › Tiện ích mở rộng › Apps Script.
 *   2. Xoá hết mã đang có, dán toàn bộ tệp này vào.
 *   3. Chọn hàm "setup" ở thanh trên rồi bấm Chạy. Google sẽ hỏi cấp quyền —
 *      chấp nhận (quyền đọc chính trang tính này và gọi mạng tới CRM).
 *   4. Xong. Từ giờ mỗi lần sửa bảng, trong 5 phút CRM sẽ có dữ liệu mới.
 *
 * KHÔNG chia sẻ tệp mã này: token bên dưới cho phép ghi báo cáo vào CRM.
 * Nghi bị lộ thì vào CRM › Báo cáo công việc › nhân viên này › "Cấp lại token"
 * rồi dán lại mã mới — token cũ chết ngay lập tức.
 */

var CRM_ENDPOINT = ${js(endpoint)};
var CRM_TOKEN = ${js(opts.token)};

/** Sheet tháng: "T1".."T12". Sheet khác (quy trình, ghi chú) được bỏ qua. */
var MONTH_SHEET = /^\\s*(?:T|Tháng)\\s*(\\d{1,2})\\s*$/i;

var PROP_DIRTY = "crmDirty";

// ---------------------------------------------------------------- CÀI ĐẶT

function setup() {
  var props = PropertiesService.getScriptProperties();
  props.setProperty("crmEndpoint", CRM_ENDPOINT);
  props.setProperty("crmToken", CRM_TOKEN);

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) ScriptApp.deleteTrigger(existing[i]);

  // Ghi nhận có sửa (không gọi mạng trong onEdit).
  ScriptApp.newTrigger("onSheetEdit").forSpreadsheet(ss).onEdit().create();
  // Có sửa thì đẩy tháng hiện tại.
  ScriptApp.newTrigger("flushChanges").timeBased().everyMinutes(5).create();
  // Lưới an toàn: đẩy đủ 12 tháng mỗi 2 giờ để không lệch dần.
  ScriptApp.newTrigger("pushAllMonths").timeBased().everyHours(2).create();

  var result = pushAllMonths();
  SpreadsheetApp.getActive().toast(
    "Đã kết nối CRM. Đẩy " + result.tabs + " sheet, " + result.rows + " dòng.",
    "CRM Louva",
    8
  );
  return result;
}

/** Ngắt kết nối: xoá trigger và token khỏi trang tính này. */
function disconnect() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) ScriptApp.deleteTrigger(triggers[i]);
  PropertiesService.getScriptProperties().deleteAllProperties();
  SpreadsheetApp.getActive().toast("Đã ngắt kết nối CRM.", "CRM Louva", 5);
}

// ---------------------------------------------------------------- TRIGGER

function onSheetEdit(e) {
  try {
    var name = e && e.range ? e.range.getSheet().getName() : null;
    if (!name || !MONTH_SHEET.test(name)) return;
    // Gom các lần sửa lại: chỉ ghi tên sheet, flushChanges() sẽ đẩy.
    var props = PropertiesService.getScriptProperties();
    var dirty = props.getProperty(PROP_DIRTY) || "";
    var set = dirty ? dirty.split("|") : [];
    if (set.indexOf(name) === -1) set.push(name);
    props.setProperty(PROP_DIRTY, set.join("|"));
  } catch (err) {
    // onEdit không được phép ném: ném là Google gửi mail lỗi mỗi lần gõ.
    console.error(err);
  }
}

function flushChanges() {
  var props = PropertiesService.getScriptProperties();
  var dirty = props.getProperty(PROP_DIRTY);
  if (!dirty) return { tabs: 0, rows: 0 };
  props.deleteProperty(PROP_DIRTY);

  var names = dirty.split("|");
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tabs = [];
  for (var i = 0; i < names.length; i++) {
    var sheet = ss.getSheetByName(names[i]);
    if (sheet) tabs.push(readSheet(sheet));
  }
  return post(tabs, "EDIT");
}

/** Đẩy đủ 12 sheet tháng. Gọi tay được từ menu Apps Script. */
function pushAllMonths() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheets = ss.getSheets();
  var tabs = [];
  for (var i = 0; i < sheets.length; i++) {
    if (MONTH_SHEET.test(sheets[i].getName())) tabs.push(readSheet(sheets[i]));
  }
  if (!tabs.length) throw new Error('Trang tính không có sheet nào tên "T1".."T12".');

  // Đẩy từng lô 3 sheet: một lần POST cả 12 sheet dễ vượt giới hạn 50 MB
  // payload và mất cả lượt đồng bộ vì một sheet nặng.
  var total = { tabs: 0, rows: 0 };
  for (var j = 0; j < tabs.length; j += 3) {
    var r = post(tabs.slice(j, j + 3), "FULL");
    total.tabs += r.tabs;
    total.rows += r.rows;
  }
  return total;
}

// ------------------------------------------------------------------- ĐỌC

/**
 * Đọc một sheet thành { rows, linkRows }.
 *
 * getDisplayValues() cho đúng chữ người xem thấy (ngày đã định dạng dd/MM/yyyy),
 * khác getValues() trả về đối tượng Date theo múi giờ của tệp — nguồn gây lệch
 * ngày kinh điển. getRichTextValues() lấy URL của ô "Link hoàn thành": ô đó
 * hiện chữ "Link" nên nếu chỉ đọc chữ thì mất đường dẫn kết quả.
 */
function readSheet(sheet) {
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 1 || lastCol < 1) {
    return { gid: String(sheet.getSheetId()), name: sheet.getName(), rows: [], linkRows: [], startRow: 1 };
  }

  var range = sheet.getRange(1, 1, lastRow, lastCol);
  var rows = range.getDisplayValues();

  var linkRows = [];
  try {
    var rich = range.getRichTextValues();
    for (var r = 0; r < rich.length; r++) {
      var line = [];
      for (var c = 0; c < rich[r].length; c++) {
        line.push(linkOf(rich[r][c]));
      }
      linkRows.push(line);
    }
  } catch (err) {
    // Sheet quá lớn hoặc ô lạ: thà mất URL còn hơn mất cả lượt đồng bộ.
    console.error(err);
    linkRows = [];
  }

  return {
    gid: String(sheet.getSheetId()),
    name: sheet.getName(),
    rows: rows,
    linkRows: linkRows,
    startRow: 1
  };
}

/** URL của ô: liên kết cả ô, hoặc liên kết của đoạn chữ đầu tiên có liên kết. */
function linkOf(richText) {
  if (!richText) return "";
  var whole = richText.getLinkUrl();
  if (whole) return whole;
  var runs = richText.getRuns();
  for (var i = 0; i < runs.length; i++) {
    var u = runs[i].getLinkUrl();
    if (u) return u;
  }
  return "";
}

// ------------------------------------------------------------------- GỬI

function post(tabs, mode) {
  if (!tabs.length) return { tabs: 0, rows: 0 };

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var payload = {
    spreadsheetId: ss.getId(),
    spreadsheetTitle: ss.getName(),
    mode: mode,
    generatedAt: new Date().toISOString(),
    tabs: tabs
  };

  var res = UrlFetchApp.fetch(CRM_ENDPOINT, {
    method: "post",
    contentType: "application/json",
    headers: { "X-Report-Token": CRM_TOKEN },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  var code = res.getResponseCode();
  var body = res.getContentText();
  if (code < 200 || code >= 300) {
    throw new Error("CRM trả về HTTP " + code + ": " + body);
  }

  var parsed = {};
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    parsed = {};
  }
  return { tabs: parsed.tabs || tabs.length, rows: parsed.entries || 0 };
}
`;
}
