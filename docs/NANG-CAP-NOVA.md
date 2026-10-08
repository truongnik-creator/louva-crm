# Nâng cấp CRM Louva cho NOVA (VÂN TRẦN DOUYIN): nhật ký 54 hạng mục

Nhánh `nang-cap-nova`, 6 lô commit. Đặc tả gốc: `SPEC-54-HANG-MUC.md` (thư mục NOVA-KHACH-HANG).
Tài liệu này ghi trạng thái từng hạng mục, tệp chính, và **các tham số mặc định chủ phòng khám phải xác nhận** trước khi chạy thật.

| Lô | Commit | Nội dung |
|---|---|---|
| 1 | `40d45ae` | Bảo mật, sao lưu, phân trang, chuẩn hoá SĐT, khung test |
| 2 | `edc5257` | Sửa lỗi báo cáo và luồng thao tác |
| 3 | `3e793d0` | Đợt 1: dữ liệu đúng và đủ |
| 4 | `fad7180` | Đợt 2: tự động hoá và bán hàng |
| 5 | `5c8b851` | Đợt 3: đo lường, lương thưởng, tăng trưởng |
| 6 | `4f1a5ca` | Sau 90 ngày: điện thoại, tư vấn và thư viện case, AI5, AI6, tài liệu |
| 7 | `38b5aac` (nhánh `nang-cap-crm-360`) | CRM 360 Lô A: pipeline khối, khách 360, hành trình, báo giá 3 phương án, bán kèm, chốt tại quầy |
| 8 | (lô này, nhánh `nang-cap-crm-360`) | CRM 360 Lô B: pipeline theo cơ hội, bước con, dòng thời gian đa kênh, hành trình, gói liệu trình, giá trị đơn, dự báo |

Trạng thái: **Xong** = làm đủ yêu cầu đặc tả, có test hoặc kiểm tay. **Một phần** = phần code xong nhưng còn phụ thuộc việc ngoài code (tài khoản thật, tài liệu API bên thứ ba, lịch chạy trên máy chủ).

Đường dẫn tệp dưới đây tính từ gốc repo; `be/` = `backend/src/`, `fe/` = `desktop/src/renderer/src/`.

## Đợt 0 · Lỗi báo cáo (B1 đến B9)

| Mục | Trạng thái | Tệp chính | Ghi chú |
|---|---|---|---|
| B1 Hợp đồng huỷ vẫn tính doanh số | Xong | `be/lib/report-scope.ts`, `be/routes/reports.ts`, `be/lib/department-scorecard.ts` | Mọi báo cáo lọc signedAt loại CANCELLED |
| B2 Báo cáo theo kênh | Xong | `be/routes/reports.ts` | `/reports/revenue?groupBy=channel` |
| B3 Công nợ kế toán lọc sai trạng thái | Xong | `be/lib/department-scorecard.ts` | SIGNED, IN_PROGRESS, COMPLETED |
| B4 Gom ngày theo giờ Việt Nam | Xong | `be/lib/datetime.ts`, `be/lib/report-scope.ts` | UTC+7 cho kỳ, ngày, tháng |
| B5 Lọc theo cơ sở | Xong | `be/routes/reports.ts`, `be/lib/department-scorecard.ts` | Khách mới, phễu, ROAS, hiệu suất, bảng điểm |
| B6 Thực thu trong kỳ | Xong | `be/routes/reports.ts` | Tiền thu trong kỳ, không phải tổng đã thu của hợp đồng ký trong kỳ |
| B7 Công nợ so kỳ trước | Xong | `be/lib/report-scope.ts` (debtBalanceAt) | Số dư đầu kỳ |
| B8 Tỉ lệ không đến | Xong | `be/routes/reports.ts` | Chỉ lịch đã tới giờ, loại lịch huỷ |
| B9 Công suất | Xong | `be/routes/reports.ts`, `be/lib/department-scorecard.ts` | Theo bác sĩ, cơ sở, giờ thật; top dịch vụ theo serviceId |

## Đợt 0 · Lỗi luồng thao tác (B10 đến B17)

| Mục | Trạng thái | Tệp chính | Ghi chú |
|---|---|---|---|
| B10 Đặt lịch từ hộp thư | Xong | `fe/pages/Appointments.tsx` | Đọc `?customerId`, mở sẵn form |
| B11 Gắn hội thoại vào hồ sơ | Xong | `be/routes/inbox.ts`, `fe/components/inbox-parts.tsx` | Tìm hoặc tạo nhanh, bắt buộc SĐT |
| B12 Mẫu tin có biến | Xong | `be/lib/quick-reply-vars.ts`, `fe/pages/QuickReplies.tsx` | Backend chặn gửi tin còn `{{` |
| B13 Ảnh, tệp trong chat | Xong | `be/lib/chat-media.ts`, `be/routes/inbox.ts` | Nút Lưu ảnh vào hồ sơ (mã hoá) |
| B14 Hợp đồng nhập tay kiểm giá sàn | Xong | `be/routes/sales.ts`, `be/lib/pricing.ts` | |
| B15 Trang chủ theo vai | Xong | `be/routes/home.ts`, `fe/components/RoleHome.tsx` | Gộp với F29 |
| B16 Chữ ký tay | Xong | `fe/components/SignaturePad.tsx`, `be/routes/medical.ts` | |
| B17 Chuẩn hoá SĐT, chống trùng, gộp | Xong | `be/lib/phone.ts`, `be/lib/customer-merge.ts`, `fe/pages/CustomerDuplicates.tsx` | Cột phoneNormalized có index |

## Đợt 0 · Bảo mật (S1 đến S7)

| Mục | Trạng thái | Tệp chính | Ghi chú |
|---|---|---|---|
| S1 Seed demo có cờ, buộc đổi mật khẩu | Xong | `backend/prisma/seed.ts`, `be/middleware/auth.ts` | `SEED_DEMO=1` |
| S2 Production thiếu JWT_SECRET thì dừng | Xong | `be/lib/env.ts` | |
| S3 ENCRYPTION_KEY_FILE ngoài data | Xong | `be/lib/env.ts`, README | |
| S4 Che SĐT ở lead và xuất dữ liệu | Xong | `be/middleware/rbac.ts`, `be/routes/leads.ts` | Kể cả phản hồi lồng và socket |
| S5 Chế độ restricted bệnh án | Xong | `be/lib/medical-scope.ts`, `be/routes/medical.ts` | |
| S6 Giới hạn đăng nhập, khoá tạm | Xong | `be/routes/auth.ts` | express-rate-limit + khoá tài khoản |
| S7 Cảnh báo quick tunnel | Xong | `share-remote.sh`, README | Từ chối chạy khi production |

## Đợt 0 · Kỹ thuật (T1 đến T5)

| Mục | Trạng thái | Tệp chính | Ghi chú |
|---|---|---|---|
| T1 Sao lưu, khôi phục | Một phần | `backend/scripts/backup.ts`, `backend/scripts/restore.ts`, `be/lib/backup.ts` | Script xong, tự sao lưu trước migrate; **lịch chạy hằng ngày (cron) phải cài trên máy chủ thật** |
| T2 npm audit | Xong | `backend/package.json` | bcryptjs; `npm audit --omit=dev` = 0 cả hai gói |
| T3 Phân trang chung | Xong | `be/lib/pagination.ts` | Mọi list endpoint; giao diện Tải thêm |
| T4 Index | Xong | migration `20260930074333_lo1_bao_mat_sdt_chi_muc` | Đồng bộ Pancake dùng phoneNormalized |
| T5 Log, upload, Electron, giờ | Xong | `be/lib/logger.ts`, `be/lib/upload.ts`, `desktop/src/main` | pino, request id, sandbox, safeStorage, CSP |
| Test | Xong | `backend/tests/` | 17 tệp, 235 test (Lô 8, gồm sửa lỗi sau chụp demo) |

## Đợt 1 · Dữ liệu đúng và đủ

| Mục | Trạng thái | Tệp chính | Ghi chú |
|---|---|---|---|
| F1 Quy trình 7 bước | Xong | `be/lib/stages.ts`, `be/lib/stage-migration.ts`, `backend/scripts/migrate-stages.ts` | Mất khách bắt buộc lý do, bảng StageHistory, tự chuyển bước theo sự kiện |
| F2 Ảnh khách từ chat | Xong | `be/lib/chat-media.ts`, `be/routes/medical.ts` | consentForMarketing có audit; mốc D0, D7, D30 |
| F3 Nhãn bước, bảng kéo thả | Xong | `fe/components/stage-parts.tsx`, `fe/pages/CustomerBoard.tsx` | |
| F4 Nhập khách Excel, CSV | Xong | `be/routes/customer-import.ts`, `fe/pages/CustomerImport.tsx` | Xem trước 20 dòng, bỏ qua, gộp, cập nhật, tệp lỗi |
| F5 Sửa Pancake | Một phần | `be/services/pancake.ts`, `be/services/pancake-sync.ts`, `be/routes/pancake.ts` | Code xong; các chỗ `TODO-VERIFY` phải đối chiếu tài liệu Pancake thật (xem cuối tài liệu) |
| F6 Chế độ phòng khám tiêm | Xong | `be/routes/clinic.ts`, `fe/lib/clinic-context.tsx`, `backend/prisma/seed.ts` | 29 dịch vụ NOVA + Combo Full Face |
| F7 Bảo mật | Xong | xem S1 đến S7 | |
| F24 Gửi vị trí, bảng giá | Xong | `be/lib/canned-messages.ts`, `fe/components/inbox-nova.tsx` | Branch mapUrl, parkingGuide, buildingGuide, facadePhotoUrl |
| F25 + F12 Cọc gắn lịch hẹn | Xong | `be/lib/deposit.ts`, `be/lib/vietqr.ts`, `fe/components/deposit-parts.tsx` | Lễ tân xác nhận cọc một nút, tự trừ cọc |
| AI1 Tách thông tin từ chat | Xong | `be/lib/extract.ts`, `be/lib/ai.ts` | Regex SĐT trước, Haiku sau, thẻ "Áp dụng" |

## Đợt 2 · Tự động hoá và bán hàng

| Mục | Trạng thái | Tệp chính | Ghi chú |
|---|---|---|---|
| F8 Bộ chạy tác vụ nền | Xong | `be/lib/jobs.ts`, `fe/pages/JobLog.tsx` | Khoá hai lớp, bảng JobRun |
| F9 8 quy tắc tự động | Xong | `be/lib/automation.ts` | Ngưỡng trong Cài đặt nhóm Tự động hoá |
| F10 Chăm sóc sau tiêm | Xong | `be/lib/aftercare.ts`, `be/routes/aftercare.ts`, `fe/pages/FollowUp.tsx` | retreatDays theo dịch vụ, bác sĩ chỉnh từng lần |
| F11 Nhóm khách, gửi theo kịch bản | Xong | `be/lib/broadcast.ts`, `be/routes/outreach.ts`, `fe/pages/Outreach.tsx` | Giới hạn mỗi giờ, optOut, cửa sổ 24 giờ |
| F13 + F21 Giá và giảm giá | Xong | `be/lib/pricing.ts`, `be/routes/promotions.ts`, `fe/pages/Promotions.tsx` | Trần giảm theo vai, duyệt vượt trần, báo cáo rò rỉ |
| F14 Lần thực hiện dịch vụ tiêm | Xong | `be/routes/surgery.ts`, `be/lib/material-consumption.ts` | volumeTenthCc, quantityTenths, costAtUse |
| F26 Hộp thư theo ca | Xong | `be/lib/inbox-routing.ts`, `fe/components/inbox-lo4.tsx` | Xoay vòng sale trong ca, đồng hồ chờ |
| F27 Việc của tôi hôm nay | Xong | `be/routes/customers.ts` (`/tasks/mine`), `fe/pages/MyTasks.tsx` | Huy hiệu số việc |
| AI2 Gợi ý câu trả lời | Xong | `be/lib/ai-assist.ts`, `be/routes/sales-scripts.ts` | Hàng rào hai lớp, prompt caching |
| AI3 Tóm tắt hội thoại | Xong | `be/lib/ai-assist.ts` | Không nạp dữ liệu y khoa |

## Đợt 3 · Đo lường, lương thưởng, tăng trưởng

| Mục | Trạng thái | Tệp chính | Ghi chú |
|---|---|---|---|
| F15 Chỉ số tuần Sales, MKT | Xong | `be/lib/analytics.ts`, `be/lib/ad-costs.ts`, `fe/pages/Analytics.tsx` | Nhập chi phí tay hoặc CSV Meta, TikTok |
| F16 Họp cuối ngày | Xong | `be/lib/analytics.ts` (endOfDay) | |
| F17 Lương thưởng theo coaching | Xong | `be/lib/payroll.ts`, `be/routes/payroll.ts`, `fe/pages/Payroll.tsx` | Mọi mức là tham số, **chờ chủ xác nhận** |
| F18 Thi đua | Xong | `be/lib/growth.ts` (leaderboard) | Mục tiêu đội mặc định 0 = chưa đặt |
| F19 Giới thiệu khách | Xong | `be/lib/growth.ts`, `be/routes/growth.ts` | |
| F20 Sinh nhật, voucher, quà | Xong | `be/lib/growth.ts`, `fe/pages/Growth.tsx` | |
| F22 Lãi gộp theo dịch vụ | Xong | `be/lib/analytics.ts` (grossMargin) | |
| F23 Tỉ lệ quay lại | Xong | `be/lib/analytics.ts` (retention, retreatDue) | |
| F29 Trang chủ theo vai | Xong | `be/routes/home.ts`, `fe/components/RoleHomeLo5.tsx` | |
| F31 Tốc độ trả lời so chốt | Xong | `be/lib/analytics.ts` (responseBuckets) | Sửa O(n²) |
| F32 Doanh thu trọn đời | Xong | `be/lib/analytics.ts` (lifetimeValue) | |
| F33 Xuất Excel kế toán | Xong | `be/lib/accounting-export.ts` | Ghi luồng theo trang, không trần 5.000 dòng |
| F34 Chỉ tiêu và dự báo | Xong | `be/lib/analytics.ts` (forecast) | |
| AI4 Chấm hội thoại | Xong | `be/lib/conversation-scoring.ts`, `fe/pages/ConversationScores.tsx` | Không nối vào lương |

## Sau 90 ngày (Lô 6)

| Mục | Trạng thái | Tệp chính | Ghi chú |
|---|---|---|---|
| F28 Dùng trên điện thoại | Xong | `fe/styles/mobile.css`, `fe/components/AppShell.tsx`, `fe/pages/Inbox.tsx`, `fe/lib/pwa.ts`, `desktop/src/renderer/public-web/` (manifest, sw.js, icons), `desktop/vite.web.config.mts` | Mốc 768px và 480px; menu ngăn kéo; hộp thư một cột (danh sách, hội thoại, hồ sơ); service worker chỉ lưu khung app, không bao giờ lưu `/api`; chỉ đăng ký ở bản web, không ở Electron |
| F30 Phiếu tư vấn, thư viện case | Xong | `be/routes/consultations.ts`, `be/lib/consultation.ts`, `be/routes/cases.ts`, `fe/pages/Consultations.tsx`, `fe/pages/CaseLibrary.tsx` | Vùng mặt, dịch vụ từ bảng giá, sản phẩm, liều 0,1 đơn vị, ảnh trước (PhotoSet CONSULT); phác đồ; báo giá theo giá niêm yết từ phác đồ; thư viện chỉ ảnh consentForMarketing, ẩn danh, lọc theo dịch vụ, hai cổng duyệt |
| AI5 Nháp tin chăm lại | Xong | `be/lib/reengage.ts`, `be/routes/reengage.ts`, `fe/pages/Reengage.tsx` | Tác vụ nền, model CHEAP, hàng chờ duyệt, duyệt xong vào hàng đợi F11 (optOut, cửa sổ 24 giờ); không gửi tên, SĐT khách lên AI |
| AI6 Bản tin sáng | Xong | `be/lib/briefing.ts`, `be/routes/home.ts`, `fe/components/RoleHomeLo6.tsx` | 7h00 giờ VN, chỉ số liệu tổng, thông báo cho giám đốc và quản lý cơ sở; thiếu AI thì bản số liệu thuần |

Migration Lô 6: `backend/prisma/migrations/20261002090000_lo6_tu_van_case_ai` (thêm cột cho ConsultationSession, TreatmentPlan, TreatmentPlanItem; bảng `reengage_drafts`, `manager_briefings`).

Phụ thuộc ở Lô 6: `desktop` nâng `react-router-dom` 6 lên 7.18 và chạy `npm audit fix` vì có lỗ hổng mới công bố (react-router, fast-uri, socket.io-parser); bản 6 không có bản vá. Giao diện chỉ dùng API chế độ thư viện (HashRouter, Routes, NavLink, useNavigate, useSearchParams) nên không phải sửa code, đã kiểm tay trên trình duyệt. `npm audit --omit=dev` = 0 cả hai gói.

Quyền thay đổi ở Lô 6: thêm `inbox.reengage` (Telesale, Tư vấn viên phạm vi của mình; Quản lý cơ sở theo cơ sở; Giám đốc, Quản trị toàn hệ thống); Giám đốc và Quản lý cơ sở được lập phiếu tư vấn (`consultation:cru`); Bác sĩ được duyệt case (`case_study.approve`, cổng chuyên môn).

## Lô 7 · CRM 360 Lô A

Đặc tả: `SPEC-CRM-360.md` (thư mục NOVA-KHACH-HANG), chỉ phần "Quyết định đã chốt" và "Lô A". Lô B làm ở Lô 8 (mục kế tiếp). Luật tính dồn vào `be/lib/crm360.ts` và nhận vào danh sách "đơn vị trên bảng" (`loadBoardUnits` trong `be/routes/crm360.ts`): khi làm P6 (pipeline theo cơ hội) chỉ cần đổi nguồn đơn vị từ khách sang cơ hội, thẻ, đầu cột, phễu, bộ lọc, nhiệt độ giữ nguyên.

| Mục | Trạng thái | Tệp chính | Ghi chú |
|---|---|---|---|
| P1 Thẻ khách khối | Xong | `be/lib/crm360.ts` (computeMetrics, stageAge, heatOf), `be/routes/crm360.ts` (`GET /api/customers/pipeline`), `fe/pages/CustomerBoard.tsx`, `fe/styles/crm360.css` | Giá trị dự kiến: báo giá mở mới nhất, không có thì phác đồ chưa báo giá, không có thì tổng giá niêm yết dịch vụ quan tâm (khớp tên bảng giá). Số ngày ở bước đọc StageHistory (lần vào bước hiện tại gần nhất), đếm theo ngày lịch giờ VN. Viền trái đỏ quá hạn, vàng sắp quá hạn. Chip cọc ở cột Lịch cọc khi có lịch sắp tới, cột khác chip nóng/ấm/lạnh. Việc kế tiếp = việc mở có hạn sớm nhất, không có thì lịch hẹn sắp tới |
| P2 Đầu cột | Xong | như trên | Số khách, tổng giá trị dự kiến (chỉ vai xem được tiền; cột Mất khách không cộng), số quá hạn / sắp quá hạn, tỉ lệ chuyển sang bước sau trong kỳ (mặc định 30 ngày) đọc StageHistory thật (`conversionFromHistory`); chưa ai vào bước thì hiện "–" |
| P3 Ba kiểu xem, lọc nhanh | Xong | `fe/pages/CustomerBoard.tsx`, `be/routes/crm360.ts` (`/pipeline/prefs`), cột `users.boardPrefs` | Dải phễu 6 khối (cao theo số khách, tiền dưới khối, % giữa khối) luôn ở đầu; Kanban khối (kéo thả đổi bước như cũ), Phễu (khối lớn + bảng chuyển đổi), Bảng. Chip: Của tôi, Nóng, Quá hạn, cơ sở (khi có từ 2 cơ sở), dịch vụ, nguồn, quảng cáo (chiến dịch), ô tìm. Kiểu xem và bộ lọc lưu trên máy chủ theo từng người |
| C1 Thanh 360 | Xong | `be/lib/customer360.ts`, `GET /api/customers/:id/360`, `fe/components/crm360-parts.tsx` (Customer360Header) | Bước + số ngày, chi trọn đời (tiền thật, bỏ voucher), số lần làm (ngày có lần thực hiện hoàn tất), đơn TB (hợp đồng đã ký chưa huỷ), lần làm cuối, hạn tái tiêm, báo giá mở, công nợ, voucher còn hạn, nguồn và quảng cáo đầu tiên, sale phụ trách, điểm hội thoại AI4 (chỉ vai có `inbox.manage_scripts`), cờ y khoa (chỉ `medical.read`, chỉ bệnh án trong cơ sở được phép, có ghi DataAccessLog) |
| C2 Gộp 9 tab còn 5 | Xong | `fe/pages/CustomerDetail.tsx`, `be/routes/aftercare.ts` (lọc `customerId`) | Tổng quan 360 · Hành trình · Tư vấn và báo giá · Y khoa và ảnh · Tài chính và quyền lợi. Sửa lỗi tồn: chế độ tiêm hiện "Chăm sóc sau tiêm" D0..D30 lấy từ việc chăm sóc thật (F10), không còn chữ hậu phẫu; chế độ phẫu thuật giữ nội dung hậu phẫu |
| J1 Dải hành trình | Xong | `be/lib/crm360.ts` (buildJourney), `be/lib/customer360.ts`, `fe/components/crm360-parts.tsx` (JourneyStrip) | Mốc: nguồn đầu tiên (luôn đứng đầu), tin nhắn đầu, gửi ảnh/ảnh tư vấn, cọc, đến cơ sở, từng lần làm dịch vụ, chăm sóc sau tiêm (số mốc đã liên hệ), lịch hẹn sắp tới, hạn tái tiêm. Mỗi mốc có ngày và "+N ngày" so với mốc trước; mốc tương lai chấm rỗng viền hổ phách, nối nét đứt |
| V1 Báo giá 3 phương án | Xong | `be/lib/quote-options.ts`, `POST /api/crm360/quote-options/preview` và `/choose`, `fe/components/crm360-parts.tsx` (QuoteOptionsPanel) | Cơ bản = dịch vụ chính (dòng đầu phác đồ), Khuyên dùng = cả phác đồ, Trọn gói = phác đồ + bán kèm theo luật + ưu đãi trọn gói. Giá niêm yết + đợt ưu đãi đang chạy có lợi nhất; phần giảm thêm bị kẹp theo trần giảm của vai người lập (không bao giờ cần duyệt). Chọn = lập báo giá thật qua `evaluatePricing` (cột `quotations.optionTier`), "Chốt" = báo giá khách đồng ý; gắn vào phác đồ nếu phác đồ chưa có báo giá. Xuất ảnh PNG (vẽ canvas, không có SĐT khách), tải về và chép vào bộ nhớ nếu trình duyệt cho |
| V2 Gợi ý bán kèm theo luật | Xong | `be/lib/upsell.ts`, `be/routes/crm360.ts` (`/upsell-rules`, `/upsell-offers`, `/customers/:id/upsell`), bảng `upsell_rules`, `upsell_offers`, `fe/pages/UpsellRules.tsx` | Luật A gợi ý B + lời gợi ý + điều kiện bằng lời + ưu tiên + "bỏ qua khách đã làm B". Hiện ở phiếu tư vấn, màn chốt tại quầy, cột 3 hộp thư, tab Tổng quan 360 và thẻ cột Đến cơ sở ("Gợi ý kèm"). Ghi đã gợi ý / khách nhận / từ chối (lý do), cùng ngày bấm gợi ý rồi nhận thì cập nhật cùng dòng; thống kê tỉ lệ nhận theo luật (chỉ đo, không nối lương). Seed 4 luật mẫu gắn nhãn "Mẫu, chờ bác sĩ duyệt" |
| V5 Màn chốt tại quầy | Xong | `fe/pages/CounterClose.tsx`, `GET /api/crm360/counter` | Khách check-in hôm nay chưa rời quầy; thanh 360, phác đồ gợi ý (phiếu gần nhất), case ảnh tương tự đã xuất bản (lọc theo dịch vụ), gợi ý bán kèm, 3 phương án với nút Chốt, rồi "Lập hợp đồng từ báo giá" (vai có `finance.create`) |
| Sửa lỗi tồn: cọc ở hộp thư | Xong | `fe/pages/Inbox.tsx`, `fe/components/deposit-parts.tsx` | Cột 3 hộp thư có khối cọc của lịch hẹn kế tiếp: yêu cầu cọc, mã VietQR, "Đã nhận cọc" (vai có `finance.create`); chưa có lịch thì nhắc đặt lịch |

Migration Lô 7: `backend/prisma/migrations/20261003090000_lo7_crm_360` (bảng `upsell_rules`, `upsell_offers`; cột `quotations.optionTier`, `users.boardPrefs`). CSDL dev đã sao lưu trước migrate (`backend/backups/louva-truoc-migrate-20261001-091932`) rồi áp migration. Luật bán kèm mẫu chỉ có sau khi chạy `npx tsx prisma/seed.ts` (chỉ nạp khi chưa có luật nào).

Quyền mới ở Lô 7: `upsell.manage` (Quản trị, Giám đốc toàn hệ thống; Quản lý cơ sở theo cơ sở: chỉ khai luật cho cơ sở mình, luật "mọi cơ sở" cần phạm vi toàn hệ thống), `upsell.review` (Bác sĩ, theo cơ sở). Sửa dịch vụ, lời gợi ý hoặc điều kiện của luật đã duyệt thì luật quay lại chờ bác sĩ duyệt.

Phụ thuộc: `desktop` chạy `npm audit fix` vì axios có lỗ hổng mới công bố (1.18.1 lên 1.20.0, cùng bản lớn, chỉ đổi package-lock). `npm audit --omit=dev` = 0 cả hai gói.

### Tham số mặc định mới cần chủ chốt (Lô 7)

Nhóm **Bảng bước khách & CRM 360** trong Cài đặt hệ thống. Các con số dưới đây do đội code đặt tạm, chưa phải số chủ phòng khám chốt.

| Khoá | Mặc định | Ý nghĩa |
|---|---|---|
| `pipeline.stageMaxDays.TIEP_CAN` | 1 | Ngày tối đa ở bước Tiếp cận (quá thì đỏ) |
| `pipeline.stageMaxDays.NHAN_TIN` | 3 | Nhắn tin |
| `pipeline.stageMaxDays.CO_ANH` | 3 | Có ảnh (khớp `automation.stuckPhoto.days`) |
| `pipeline.stageMaxDays.LICH_COC` | 7 | Lịch cọc |
| `pipeline.stageMaxDays.DEN_CO_SO` | 1 | Đến cơ sở |
| `pipeline.stageMaxDays.LAM_DICH_VU` | 0 | 0 = không tính quá hạn |
| `pipeline.stageMaxDays.QUAY_LAI` | 0 | 0 = không tính quá hạn |
| `pipeline.stageMaxDays.default` | 7 | Bước chưa khai riêng (chế độ phẫu thuật) |
| `pipeline.warnPercent` | 70% | Đạt bao nhiêu % ngưỡng thì viền vàng sắp quá hạn |
| `pipeline.conversionDays` | 30 | Kỳ tính tỉ lệ chuyển giữa các cột |
| `heat.recentDays` | 3 | Tương tác (khách nhắn vào hoặc đến cơ sở) trong bao nhiêu ngày là "gần" |
| `heat.weight.recent` / `photo` / `appointment` / `quote` | 2 / 1 / 2 / 1 | Điểm từng dấu hiệu |
| `heat.hotMin` / `heat.warmMin` | 4 / 2 | Tổng điểm từ mức này là Nóng / Ấm, dưới là Lạnh (mất khách luôn Lạnh) |
| `quote.packageDiscountPercent` | **0%** | Ưu đãi thêm cho phương án Trọn gói (luôn bị kẹp theo `discount.capPercent.*` của người lập) |
| `upsell.maxSuggestions` | 3 | Số gợi ý bán kèm tối đa mỗi khách |
| Luật bán kèm mẫu (4 luật) | nhãn "mẫu" | Gọn hàm Hàn → Tan mỡ nọng; Filler Youthfill → Meso cấp ẩm; Hốc mắt Hàn → Botox xoá nhăn; HIFU 500S → Meso căng bóng. **Bác sĩ phải duyệt hoặc tắt trước khi dùng thật** |

### Quyết định đội code tự chọn ở Lô 7 (cần chủ xác nhận)

- **Ai thấy tiền (Quyết định 3)**: hiểu là `finance.read` phạm vi cơ sở hoặc toàn hệ thống. Telesale có `finance.read` phạm vi "của mình" nên vẫn bị ẩn tiền trên thẻ và thanh 360. Áp thêm cho cột 3 hộp thư (ẩn "Tổng đã chi tiêu", công nợ chỉ hiện nhãn "Có công nợ"). Tab Tài chính và màn hợp đồng giữ quyền như cũ. Số tiền cọc của lịch hẹn vẫn hiện cho telesale vì phải báo khách chuyển khoản.
- **Giá trị dự kiến** khi không có báo giá, phác đồ: cộng giá niêm yết các dịch vụ quan tâm khớp đúng tên bảng giá; dịch vụ quan tâm ghi tự do không khớp tên thì không tính.
- **Nhiệt độ**: "tương tác gần" chỉ tính khách nhắn vào hoặc khách đến cơ sở (không tính nhân viên nhắn đi).
- **Phương án Cơ bản** = dòng đầu của phác đồ (dịch vụ chính). Phác đồ chỉ có một dòng thì Cơ bản trùng Khuyên dùng.
- **Luật mẫu chưa duyệt vẫn hiện gợi ý** nhưng mang nhãn "Mẫu, chờ bác sĩ duyệt"; muốn chặn hẳn thì tắt luật.
- **Màn chốt tại quầy**: tư vấn viên được lễ tân giao tiếp khách check-in hôm nay mở được thanh 360, gợi ý, báo giá của khách đó dù khách không thuộc mình phụ trách.
- **Điểm hội thoại AI4** trên thanh 360 chỉ hiện với vai quản lý kịch bản (cùng quyền màn Chấm hội thoại), vì đây là điểm chấm nhân viên.

## Lô 8 · CRM 360 Lô B

Đặc tả: `SPEC-CRM-360.md`, phần "Lô B", tuân thủ "Quyết định đã chốt" (pipeline theo cơ hội, giá trị đơn chỉ đo, tiền chỉ vai `finance.read` cơ sở/toàn hệ thống thấy, mọi ngưỡng là tham số, không bịa xác suất). Luật cơ hội ở `be/lib/opportunities.ts`; mọi đổi bước vẫn đi qua `stages.changeStage`, giờ đổi bước CỦA CƠ HỘI rồi đồng bộ `Customer.stage`.

| Mục | Trạng thái | Tệp chính | Ghi chú |
|---|---|---|---|
| P4 Bước con, điều kiện khi kéo | Xong | `be/lib/opportunities.ts` (parseSubStages, subStageOf, checkStageRequirements, assertStageRequirements), `be/routes/customers.ts` (`/:id/stage`), `be/routes/crm360b.ts`, `fe/pages/CustomerBoard.tsx` | Cơ chế bước con chung (tham số `pipeline.subStages`); Lịch cọc tách "Đã hẹn chưa cọc" / "Đã cọc" tự tính theo cọc của lịch hẹn sắp tới, đầu cột đếm từng bước con; bước con khác chọn tay trên cơ hội. Giới hạn số thẻ mỗi cột (`pipeline.wipLimits`) chỉ cảnh báo đỏ ở đầu cột, không chặn. Điều kiện bắt buộc khi đổi bước TAY: bước trong `pipeline.requireAppointmentStages` phải có lịch hẹn sắp tới chưa huỷ; bước trong `pipeline.requireContractStages` phải có hợp đồng chưa huỷ của cơ hội. Thiếu thì 409 kèm `missing`, `action`. Sự kiện thật (cọc, check-in, hoàn tất lần thực hiện) vẫn tự chuyển bước, không bị chặn |
| P5 Thả thẻ mở hành động | Xong | `GET /api/crm360/opportunities/:id/drop-check` (và `/customers/:id/drop-check`), `fe/components/crm360b-parts.tsx` (useDropActions, QuickBookModal) | Thả vào cột cần lịch mà chưa có lịch: mở form đặt lịch (tiền cọc gợi ý theo `deposit.defaultAmount`), đặt xong tự chuyển; có lịch chưa cọc: chuyển rồi mở khối cọc VietQR; thiếu hợp đồng: mở form tạo hợp đồng (vai có `finance.create`), tạo xong tự chuyển; Mất khách: hỏi lý do; Đến cơ sở: chuyển rồi mở báo giá 3 phương án. Lùi bước vẫn hỏi lý do. Cùng luồng dùng cho ô chọn bước trên thẻ cơ hội ở hồ sơ |
| P6 Pipeline theo cơ hội | Xong | `be/lib/opportunities.ts`, `be/lib/stages.ts` (changeStage, applyStageEvent), `be/routes/crm360.ts` (loadBoardUnits), `be/routes/crm360b.ts`, `backend/scripts/migrate-opportunities.ts`, bảng `opportunities`, cột `stage_history.opportunityId` | Cơ hội: khách, dịch vụ quan tâm, giá trị dự kiến (nhập tay, trống thì tính từ báo giá/phác đồ/bảng giá), ngày dự kiến chốt, bước, bước con, nguồn, sale, mở/thắng/thua, lý do thua. Thắng = bước Làm dịch vụ, Quay lại (phẫu thuật: từ Đã phẫu thuật). `Customer.stage` = bước của cơ hội đang mở mới nhất, không có thì cơ hội gần nhất. Bảng Kanban đọc cơ hội: mỗi cơ hội mở một thẻ; khách không có cơ hội mở hiện cơ hội gần nhất; khách chưa có cơ hội (dữ liệu chưa chuyển) hiện như Lô A. Thẻ giữ `id` = id khách, thêm `opportunityId`. Tỉ lệ chuyển giữa cột đếm theo cơ hội. Báo giá, hợp đồng mới gắn cơ hội hiện tại. Gộp hồ sơ chuyển cả cơ hội. Test hồi quy: 9 báo cáo cũ (`/reports/dashboard`, `/revenue`, `/marketing/funnel`, `/staff-performance`, `/analytics/weekly`, `/eod`, `/retention`, `/ltv`, `/home`), bảng bước và bước khách ra kết quả y hệt trước và sau khi chuyển dữ liệu |
| C3 Hồ sơ nhu cầu chọn nhanh | Xong | `be/lib/needs.ts`, `/api/crm360/customers/:id/needs`, `/needs/suggest`, cột `customers.needsProfile`, `fe/components/crm360b-parts.tsx` (NeedsCard) | Vùng muốn làm (12 vùng mặt của phiếu tư vấn), ngân sách, nỗi sợ, người quyết định, dịp (+ ngày), nơi đang so sánh (chữ tự do). Danh sách lựa chọn là tham số; máy chủ từ chối lựa chọn ngoài danh sách; ghi nhật ký kiểm toán. AI1 gợi ý điền từ 40 tin khách gần nhất, chỉ khi AI bật và khách đã đồng ý xử lý dữ liệu bằng AI; bỏ phần AI đoán ngoài danh sách; không tự lưu |
| C4 Dòng thời gian đa kênh | Xong | `GET /api/crm360/customers/:id/timeline`, `POST /customers/:id/calls`, `fe/components/crm360b-parts.tsx` (TimelineCard) | Gom tin nhắn (ghi rõ kênh Zalo, Facebook theo hội thoại), cuộc gọi, lần đến, lịch hẹn, báo giá (kèm lý do từ chối), thanh toán, hợp đồng, đổi bước, mở cơ hội, ghi chú, buổi gói liệu trình. Lọc theo loại và theo kênh chat; phân trang bằng mốc `before`. Số tiền ẩn với vai không xem được tiền. Cuộc gọi là ghi tay (chưa nối tổng đài) |
| J2 Báo cáo hành trình | Xong | `be/lib/crm-reports.ts` (journeySummary, journeyByGroup), `GET /api/crm360/reports/journey`, `fe/pages/CrmReports.tsx` | Số ngày trung bình ở mỗi bước (chỉ lượt đã rời bước), số lượt rơi sang Mất khách từ mỗi bước, bước rơi nhiều nhất; tổng và theo sale, kênh, dịch vụ, cơ sở. Phạm vi xem theo `customer.read` (telesale chỉ thấy cơ hội của khách mình) |
| J3 Việc theo bước | Xong | bảng `stage_checklist_items`, `be/lib/opportunities.ts` (createStageTasks), `/api/crm360/stage-checklist`, `fe/pages/StageChecklist.tsx` | Mỗi bước có checklist việc + mẫu tin gợi ý + hạn (số ngày sau khi vào bước). Cơ hội vào bước (đổi tay hoặc tự động) thì tự tạo việc (loại STAGE_CHECKLIST) cho sale phụ trách cơ hội; việc cùng mục còn mở thì không tạo trùng. Quyền mới `pipeline.manage`. Seed 6 việc mẫu (gắn nhãn mẫu) khi chạy `prisma/seed.ts` |
| V3 Gói liệu trình | Xong | bảng `treatment_packages`, `package_sessions`, `be/lib/packages.ts`, `/api/crm360/packages*`, `fe/components/crm360b-parts.tsx` (PackagesCard), tác vụ nền `package-reminder` | Gói lập từ một dòng hợp đồng nhiều buổi (số buổi mặc định = số lượng dòng); theo dõi đã dùng/còn lại, hạn dùng; "Dùng 1 buổi" trừ có điều kiện (không trừ hai lần), cộng `deliveredQty` của dòng hợp đồng; hết buổi thì xong. Nhắc đặt buổi tiếp: quá số ngày kể từ buổi gần nhất mà không có lịch sắp tới thì tạo việc cho sale (mỗi mốc buổi một lần). Khách còn gói còn buổi thì check-in không mở cơ hội mới. **Kế toán**: xem mục dưới |
| V4 Giá trị đơn trung bình | Xong | `be/lib/crm-reports.ts` (aovReport), `GET /api/crm360/reports/aov` | Theo sale (tư vấn viên của hợp đồng), bác sĩ (bác sĩ chốt, không có thì bác sĩ lần thực hiện đầu), cơ sở, dịch vụ đầu vào (dịch vụ dòng đầu của hợp đồng đầu tiên khách ký), kênh; tỉ lệ đơn có bán kèm (dòng upsale hoặc gợi ý V2 được nhận trên báo giá của hợp đồng); tỉ lệ khách nhận gợi ý V2. **Chỉ đo, không nối lương, thi đua** (không file lương, thi đua nào đọc số này) |
| V6 Báo giá bị từ chối | Xong | `be/routes/sales.ts` (`/quotations/:id/status`, createQuoteFollowup), cột `quotations.rejectReason`, `followupTaskId`, `fe/components/crm360b-parts.tsx` (QuotesCard) | Khách từ chối bắt buộc lý do (≥ 3 ký tự); tự tạo việc QUOTE_FOLLOWUP "chăm lại" hạn sau `quote.rejectFollowupDays` ngày cho tư vấn viên, rồi telesale, rồi người lập; ghi vào dòng thời gian. Giao diện thêm khối Báo giá (Đã gửi, Đồng ý, Từ chối) ở tab Tư vấn và báo giá (trước Lô 8 chưa có chỗ bấm) |
| V7 Dự báo pipeline | Xong | `be/lib/crm-reports.ts` (stageProbabilities, forecastReport), `GET /api/crm360/reports/forecast` | Xác suất bước S = số cơ hội từng vào S rồi thắng / số cơ hội từng vào S đã có kết quả (thắng hoặc mất), trong `forecast.lookbackDays` ngày. Dưới `forecast.minSamples` (mặc định 30) thì "chưa đủ dữ liệu": không cộng vào dự báo, hiện riêng số cơ hội và giá trị chưa đủ dữ liệu. Dự báo = giá trị dự kiến × xác suất; theo tháng (ngày dự kiến chốt, không có thì lịch hẹn sắp tới, không có thì "chưa có ngày dự kiến"), theo sale, theo bước |

Migration Lô 8: `backend/prisma/migrations/20261004090000_lo8_crm_360_b` (bảng `opportunities`, `stage_checklist_items`, `treatment_packages`, `package_sessions`; cột `stage_history.opportunityId`, `customers.needsProfile`, `quotations.opportunityId|rejectReason|followupTaskId`, `contracts.opportunityId`, `tasks.opportunityId|stageKey|checklistItemId`). Migration chỉ đổi cấu trúc, KHÔNG chuyển dữ liệu: chuyển dữ liệu bằng script bên dưới. CSDL dev đã sao lưu (`backend/backups/louva-truoc-migrate-20261001-095322`) rồi áp migration; script chuyển dữ liệu CHƯA chạy trên CSDL dev, chỉ chạy trên bản sao.

Giao diện mới: menu Kinh doanh thêm "Việc theo bước" (`/viec-theo-buoc`) và "Báo cáo CRM 360" (`/bao-cao-crm-360`, tab Hành trình cho mọi vai xem khách; Giá trị đơn, Dự báo, Gói liệu trình chỉ vai xem được tiền). Hồ sơ khách: tab Tổng quan thêm Cơ hội bán; tab Hành trình thay dòng thời gian cũ bằng dòng thời gian đa kênh; tab Tư vấn thêm Hồ sơ nhu cầu và Báo giá; tab Tài chính thêm Gói liệu trình.

### Chuyển dữ liệu sang cơ hội (P6)

Mỗi khách hiện có (trừ hồ sơ đã gộp) thành ĐÚNG MỘT cơ hội mang bước hiện tại, lý do mất, sale phụ trách, nguồn, cơ sở chính, dịch vụ quan tâm đầu tiên khớp bảng giá; toàn bộ lịch sử bước cũ gắn vào cơ hội đó. `Customer.stage` không đổi nên báo cáo, lương, tự động hoá ra cùng kết quả. Chạy lại bao nhiêu lần cũng được.

1. Chạy trên BẢN SAO trước:
   ```
   cd backend
   npx tsx scripts/backup.ts --kind thu-cong            # lấy bản sao crm.db trong backups/
   export DATABASE_URL="file:/đường/dẫn/ban-sao/crm.db"
   npx prisma migrate deploy
   npx tsx scripts/migrate-opportunities.ts             # xem trước, không ghi
   npx tsx scripts/migrate-opportunities.ts --yes --no-backup
   ```
   Cuối lần chạy thật script tự kiểm: số khách theo bước không đổi, không còn khách thiếu cơ hội, bước khách khớp cơ hội hiện tại (thoát mã 2 nếu sai).
2. Nếu script báo khách còn bước của bộ bước khác (CSDL dev hiện có 12 khách ở bộ bước phẫu thuật cũ: MOI, LIENHE, HEN, DEN, CHOT, HAUPHAU, TAIMUA trong khi chế độ là tiêm), script dừng: chạy trước `npx tsx scripts/migrate-stages.ts --yes` (đã sửa để cơ hội đổi bước theo) rồi chạy lại.
3. Chạy thật trên CSDL chính: `npx tsx scripts/migrate-opportunities.ts --yes` (tự sao lưu kiểu `truoc-migrate` trước khi ghi).
4. Không chạy script cũng không hỏng: khách chưa có cơ hội được tạo đúng một cơ hội theo cùng luật ngay lần đầu đổi bước hoặc có sự kiện; bảng bước hiện khách đó như Lô A.

Kết quả chạy thử trên bản sao CSDL dev ngày 01/10/2026: lần đầu dừng vì 12 khách ở bộ bước cũ; sau `migrate-stages --yes`: tạo 12 cơ hội (9 mở, 3 thắng), gắn 12 dòng lịch sử; kiểm tra "số khách theo bước KHÔNG ĐỔI; khách chưa có cơ hội: 0; lệch bước: 0"; chạy lại lần hai tạo 0.

### Kế toán gói liệu trình (V3)

Hệ thống hiện ghi **doanh số theo hợp đồng đã ký** (`signedAt`, loại hợp đồng huỷ) và **thực thu theo phiếu thu** (`paidAt`). Không có khái niệm "doanh thu ghi nhận theo buổi thực hiện" trong báo cáo tài chính, nên Lô 8 **giữ nguyên cách cũ, không tự đổi chuẩn kế toán**: gói bán qua hợp đồng như mọi dịch vụ (cả giá trị gói vào doanh số ngày ký), tiền trả trước vào thực thu ngày thu. Gói chỉ theo dõi thêm, để kế toán tham khảo (không đưa vào báo cáo doanh thu): giá trị mỗi buổi = giá gói chia đều (buổi cuối nhận phần dư, tổng đúng bằng giá gói), giá trị buổi đã dùng, phần tiền đã thu trước chưa thực hiện (`GET /api/crm360/packages/summary`). Muốn ghi nhận doanh thu theo buổi thì kế toán và chủ phòng khám phải quyết định đổi chuẩn báo cáo, đó là việc riêng.

### Tham số mặc định mới cần chủ chốt (Lô 8)

Nhóm **CRM 360: cơ hội, bước con, báo cáo** trong Cài đặt hệ thống (trừ dòng nhắc gói ở nhóm Tự động hoá). Số do đội code đặt tạm.

| Khoá | Mặc định | Ý nghĩa |
|---|---|---|
| `pipeline.subStages` | `LICH_COC:HEN_CHUA_COC=Đã hẹn chưa cọc\|DA_COC=Đã cọc;HEN:...` | Bước con từng bước; HEN_CHUA_COC, DA_COC tự tính theo cọc |
| `pipeline.wipLimits` | trống | Giới hạn số thẻ mỗi cột (cảnh báo), dạng `LICH_COC:40,DEN_CO_SO:20` |
| `pipeline.requireAppointmentStages` | LICH_COC, HEN | Kéo tay sang bước này phải có lịch hẹn sắp tới |
| `pipeline.requireContractStages` | LAM_DICH_VU, QUAY_LAI, PT | Kéo tay sang bước này phải có hợp đồng chưa huỷ |
| `pipeline.stageTasks.enabled` | bật | Tự tạo việc theo checklist khi vào bước |
| `opportunity.autoOpenEvents` | DEPOSIT_CONFIRMED, CHECK_IN | Sự kiện mở cơ hội mới cho khách đã làm dịch vụ |
| `opportunity.reopenMinDays` | 14 | Trong số ngày này sau lần làm dịch vụ thì không tự mở cơ hội mới (tái khám, chăm sóc) |
| `needs.budgetOptions` | Dưới 5 triệu, 5 đến 10 triệu, 10 đến 20 triệu, 20 đến 50 triệu, Trên 50 triệu | Lựa chọn ngân sách |
| `needs.fearOptions` | Đau, Sưng bầm, Không tự nhiên, Biến chứng, Phải nghỉ dưỡng, Giá cao, Sợ người khác biết | Lựa chọn nỗi sợ |
| `needs.decisionMakerOptions` | Tự quyết, Chồng hoặc người yêu, Bố mẹ, Bạn bè, Người khác trả tiền | Lựa chọn người quyết định |
| `needs.occasionOptions` | Cưới, Tết, Sinh nhật, Chụp ảnh hoặc sự kiện, Du lịch, Không có dịp | Lựa chọn dịp |
| `quote.rejectFollowupDays` | **14** | Báo giá bị từ chối: chăm lại sau bao nhiêu ngày |
| `package.reminderIntervalDays` | **30** | Nhắc đặt buổi tiếp sau bao nhiêu ngày (gói khai riêng thì theo gói) |
| `package.defaultValidDays` | 365 | Hạn dùng gói gợi ý khi lập (0 = không hạn) |
| `automation.packageReminder.enabled` | bật | Tác vụ nền nhắc gói |
| `report.crm360.defaultDays` | 90 | Kỳ mặc định báo cáo hành trình, giá trị đơn |
| `forecast.minSamples` | **30** | Số cơ hội đã có kết quả tối thiểu để tính xác suất một bước |
| `forecast.lookbackDays` | 365 | Khoảng lịch sử bước dùng tính xác suất |
| `upsell.declineCooldownDays` | **30** | Báo giá 3 phương án: không tự cộng vào Trọn gói dịch vụ bán kèm khách đã từ chối trong số ngày này (0 = luôn cộng). Thêm khi sửa lỗi sau chụp demo |
| Checklist việc theo bước mẫu (6 việc) | nhãn "mẫu" | Nhắn tin: hỏi nhu cầu, mời gửi ảnh; Có ảnh: gửi nhận xét bác sĩ, mời đặt lịch có cọc; Lịch cọc: gọi xác nhận lịch; Đến cơ sở: lập báo giá 3 phương án; Làm dịch vụ: gửi hướng dẫn chăm sóc sau tiêm. **Chủ phòng khám sửa hoặc tắt trước khi dùng thật** |

### Quyết định đội code tự chọn ở Lô 8 (cần chủ xác nhận)

- **Khi nào tự mở cơ hội mới**: chỉ khi cơ hội hiện tại đã THẮNG (đã làm dịch vụ) và có sự kiện cọc hoặc check-in, quá 14 ngày sau lần làm dịch vụ gần nhất, khách không còn gói liệu trình còn buổi. Tin nhắn và ảnh không tự mở (khách chăm sóc sau tiêm vẫn nhắn, gửi ảnh); muốn mở khi khách nhắn hỏi dịch vụ mới thì sale bấm "Mở cơ hội mới" ở hồ sơ. Khách đã MẤT có sự kiện mạnh (cọc, check-in, làm dịch vụ) thì mở lại chính cơ hội đó như luật cũ, không tạo cơ hội mới.
- **Khi đã có cơ hội mở mới hơn, bước khách đổi theo cơ hội mới** (Quyết định 1): khách đã làm dịch vụ quay lại check-in thì `Customer.stage` chuyển từ Làm dịch vụ về Đến cơ sở. Báo cáo đếm theo bước khách sẽ thấy khách đó ở bước mới.
- **Cơ hội thắng** = bước Làm dịch vụ, Quay lại (phẫu thuật: Đã phẫu thuật trở đi). Đã chốt hợp đồng (phẫu thuật) vẫn là cơ hội mở.
- **Gộp hồ sơ**: cơ hội của hồ sơ trùng chuyển sang hồ sơ giữ lại; bước khách sau khi gộp = cơ hội mở mới nhất của cả hai.
- **Bảng bước**: thẻ vẫn mang `id` = id khách để mở đúng hồ sơ; khách có nhiều cơ hội mở hiện nhiều thẻ, thẻ ghi tên cơ hội. Bộ lọc "Của tôi" gồm khách mình phụ trách và cơ hội mình là sale.
- **Giá trị dự kiến nhập tay** trên cơ hội chỉ vai xem được tiền mới nhập, sửa được (telesale, tư vấn viên không thấy tiền nên không nhập). Thứ tự tính giá trị khi không nhập tay: xem "Sửa lỗi sau chụp demo" bên dưới.
- **Điều kiện P4 chỉ chặn đổi bước tay**; sự kiện thật vẫn tự chuyển. Hợp đồng "của cơ hội" = hợp đồng gắn cơ hội hoặc lập từ ngày mở cơ hội.
- **Lễ tân thấy giá trị buổi gói** vì có `finance.read` phạm vi cơ sở (cùng cách hiểu Quyết định 3 ở Lô 7).
- **Dự báo**: chỉ cơ hội đã có kết quả mới vào mẫu (cơ hội đang mở không kéo xác suất xuống). Tháng dự kiến lấy ngày dự kiến chốt sale nhập, không có thì lịch hẹn sắp tới.
- **Dịch vụ đầu vào (V4)** = dịch vụ dòng đầu của hợp đồng đầu tiên khách ký; **đơn có bán kèm** = có dòng upsale (`upsellById`) hoặc gợi ý V2 được nhận trên báo giá của hợp đồng.
- **Cuộc gọi (C4)** ghi tay vì chưa có tổng đài; khi nối tổng đài thì ghi vào cùng loại hoạt động CALL.
- Quyền mới `pipeline.manage` (Quản trị, Giám đốc toàn hệ thống; Quản lý cơ sở theo cơ sở). Lập gói cần `finance.create`, huỷ gói `finance.update`, trừ buổi `customer.update` (cả cơ sở đang có khách check-in hôm nay).

### Sửa lỗi sau chụp demo

Bốn lỗi phát hiện khi chụp ảnh demo Lô 7, Lô 8. Mỗi lỗi có test tái hiện ở `backend/tests/lo8-sua-loi-demo.test.ts` (7 test, chạy trên mã cũ thì 6 test hỏng).

| Lỗi | Nguyên nhân | Cách sửa |
|---|---|---|
| 1. Cơ hội mở tay (ví dụ HIFU 500S, niêm yết 7,5 tr) hiện "Chưa rõ dịch vụ" và giá trị 98,0 tr | `computeMetrics` (`be/lib/crm360.ts`) với cơ hội hiện tại xét tổng giá dịch vụ quan tâm cũ của khách (nguồn INTEREST) TRƯỚC giá niêm yết dịch vụ của cơ hội; đơn vị chính còn nhận mọi báo giá, phác đồ chưa gắn cơ hội kể cả lập trước khi mở cơ hội. Thẻ lấy tên dịch vụ từ `interest[0]` của khách, bỏ trống khi khách có nhiều cơ hội | Thứ tự giá trị: nhập tay → báo giá mở của cơ hội → phác đồ của cơ hội → giá niêm yết dịch vụ của cơ hội → (chỉ khi cơ hội không có dịch vụ) dịch vụ quan tâm. Báo giá, phác đồ chưa gắn cơ hội (dữ liệu cũ) thuộc cơ hội mới nhất mở trước ngày lập (lập trước mọi cơ hội thì thuộc cơ hội sớm nhất), nên cơ hội mở sau không kế thừa, cơ hội cũ vẫn giữ. Thẻ có trường `serviceName` lấy từ cơ hội. Thanh 360 (`be/lib/customer360.ts`) lấy giá trị dự kiến của cơ hội hiện tại, cùng số với thẻ |
| 2a. Ô "Việc cần làm với khách này" báo "Không có việc tồn đọng" trong khi thanh 360 có việc kế tiếp | `TodoCard` (`fe/pages/CustomerDetail.tsx`) không đọc bảng việc, chỉ tính công nợ, thiếu sale, thiếu SĐT; thanh 360 đọc mọi việc mở của khách. Không phải lọc theo người được giao | `GET /api/customers/:id/360` trả thêm `openTasks` (mọi việc mở của khách, mọi người được giao, việc có hạn trước, tối đa 50) từ cùng truy vấn với `nextTask`; ô Việc cần làm hiện danh sách này (quá hạn tô đỏ, ghi hạn và người được giao) cùng các mục cũ |
| 2b. Check-in sang Đến cơ sở không thấy việc theo bước J3 | Trên CSDL demo việc J3 THỰC RA đã được tạo (Nguyễn Khánh Linh: "Lập báo giá 3 phương án sau khi bác sĩ khám", sự kiện check-in đã nối `createStageTasks` qua `changeStage`), nhưng không hiện ở ô Việc cần làm (lỗi 2a) và thẻ bảng chỉ hiện việc có hạn sớm nhất. Ngoài ra có lỗ hổng thật: cơ hội chưa gắn cơ sở (lead từ chat chưa có cơ sở) chỉ nhận việc "mọi cơ sở", bỏ sót việc khai riêng cho cơ sở; khách chưa có sale thì việc không giao cho ai | `createStageTasks` chọn cơ sở theo thứ tự: cơ sở của cơ hội → cơ sở của sự kiện (check-in truyền cơ sở qua `applyStageEvent` → `changeStage`/`openOpportunity`) → cơ sở chính của khách. Không có sale phụ trách thì giao cho người làm đổi bước (lễ tân check-in, người kéo thẻ). Việc ghi cơ sở đã chọn |
| 3. Trọn gói (V1) vẫn cộng dịch vụ bán kèm khách vừa TỪ CHỐI (V2) | Đặc tả không có luật này; `buildQuoteOptions` cộng mọi gợi ý có giá, không xem lần từ chối gần nhất | Không tự cộng dịch vụ có lần gợi ý gần nhất là "Khách từ chối" trong `upsell.declineCooldownDays` ngày (mặc định 30, 0 = cộng như trước). Kết quả trả `skippedDeclined`; giao diện ghi dưới Trọn gói "Không cộng X: khách đã từ chối ngày ...". Gợi ý vẫn hiện ở danh sách bán kèm với nhãn Khách từ chối; khách đổi ý thì bấm Khách nhận, lần gần nhất thành "nhận" và Trọn gói cộng lại |
| 4. Ghi chú hồ sơ nhu cầu (C3) lưu được qua API nhưng không hiện | Đúng lỗi giao diện: `NeedsCard` không có ô Ghi chú | Thêm ô Ghi chú (tối đa 500 ký tự) vào Hồ sơ nhu cầu, chỉ xem thì hiện chữ. Máy chủ lưu chuỗi rỗng thành null (xoá ghi chú) |

Hệ quả cần chủ biết: cơ hội chuyển từ dữ liệu cũ (P6) mang dịch vụ quan tâm ĐẦU TIÊN khớp bảng giá, nên giá trị dự kiến giờ là giá dịch vụ đó, không còn cộng mọi dịch vụ quan tâm (ví dụ demo: cột Đến cơ sở 163,0 tr thành 145,0 tr; dự báo tổng giá trị 310,0 tr thành 191,0 tr). Muốn giá trị đủ thì nhập tay giá trị dự kiến hoặc lập báo giá cho cơ hội.

Ảnh demo đã chụp lại sau bản sửa: 57, 58, 59, 60, 61, 64, 65, 68, 69, 73, 76, 81, 83, 84, 85.

## F35 · Hiệu suất nhân viên trên Pancake (kéo số mỗi 10 phút)

**Vấn đề:** báo cáo "Tốc độ trả lời" sẵn có chỉ đo được tin nhắn ĐÃ VÀO CRM, và
chỉ quy được về người gửi khi tin đó gửi TỪ CRM. Thực tế nhân viên trả lời khách
ngay trong app Pancake, nên CRM chỉ có bản sao tin nhắn mà không biết ai bấm
gửi — cột "số tin một nhân viên xử lý" trống.

**Cách làm:** lấy thẳng số Pancake tự đo.

| Hạng mục | Nguồn |
| --- | --- |
| Số tin một nhân viên xử lý | `inbox_count` + `comment_count` của `GET /pages/{page_id}/statistics/users` |
| Tốc độ phản hồi trung bình | `average_response_time` (**giây**) của cùng API |
| Số tin theo nền tảng, kênh | gom theo `platform` và theo trang của `PancakePage` |

**Hai tác vụ nền, mỗi 10 phút** (`backend/src/lib/pancake-jobs.ts`):

- `pancake-pull-sync` — kéo hội thoại, tin nhắn (công tắc `pancake.autoSync.enabled`).
- `pancake-agent-stats` — kéo thống kê hiệu suất (công tắc `pancake.statsSync.enabled`).

**Quy ước số liệu**

- Ghi bằng upsert theo (trang, nhân viên, mốc giờ) nên kéo lại cùng khoảng thời
  gian KHÔNG cộng dồn. Cửa sổ kéo phủ cả hôm qua để chốt những giờ cuối ngày.
- **Nạp lại lịch sử**: tác vụ 10 phút chỉ kéo hôm qua và hôm nay, nên báo cáo 7
  ngày và theo tháng sẽ trống ở những ngày trước khi bật tính năng. Nút "Nạp lại
  30 ngày" ở màn Kết nối (hoặc `POST /api/pancake/:id/sync-stats?days=N`, chặn
  ở 90) kéo bù, chia theo từng tuần để phản hồi không quá lớn.
- Trung bình phản hồi của cả kỳ tính CÓ TRỌNG SỐ theo số tin trong từng ô giờ.
- Ô Pancake trả `average_response_time = 0` coi là KHÔNG ĐO ĐƯỢC (hiện "—"),
  không phải trả lời tức thì; nhưng số tin của ô đó vẫn được cộng.
- Tham số `date_range` GỬI ĐI theo giờ Việt Nam; mốc giờ NHẬN VỀ đọc từ
  `hour_in_integer` (UTC), không đọc `hour` (giờ địa phương của trang). Hai thứ
  không được trộn (xem `parseStatHour`, `pancakeDateRange`).

**Gắn nhân viên:** bảng `pancake_agents` nối user Pancake với tài khoản CRM. Dò
tự động ở Kết nối › Nhân viên Pancake, tự gắn khi tên khớp duy nhất (bỏ dấu);
trùng tên hai người thì để quản trị chọn tay. Tin gửi từ CRM mang thêm
`sender_id` để Pancake quy về đúng người, nhờ đó số không bị hụt.

**Xem ở:** Đo lường › Hiệu suất Pancake (`GET /api/reports/pancake-agents`).
Gắn nhân viên: Kết nối Zalo / Tổng đài › tab Pancake › Nhân viên Pancake.

**Kéo hội thoại bỏ qua phần không đổi:** danh sách Pancake luôn trả 60 hội thoại
gần nhất, mà mỗi hội thoại phải một lượt gọi riêng để lấy tin. Kéo hết mỗi 10
phút là ~240 lượt cho 4 trang, đo trên máy chủ thật mất 95 giây. Nay so
`updated_at` của Pancake với mốc tin cuối đã lưu: không mới hơn thì không gọi.
Hội thoại lạ hoặc Pancake không trả `updated_at` thì vẫn kéo, để không bao giờ
sót tin của khách.

### Ba lỗi dữ liệu chỉ chạy thật mới lộ ra

Đo trên máy chủ sau lượt đồng bộ đầu (2.814 tin, 240 hội thoại, 4 trang):

**1. 287 "tệp đính kèm" là giả, tên tệp là nguyên bài quảng cáo.**

Pancake gói rất nhiều thứ vào mảng `attachments`, không chỉ tệp. Gặp thật 11
loại: `photo`, `video`, `sticker`, `file` (là media) và `ad_click`, `link`,
`reaction`, `address`, `template`, `replied_message`, `response_feedback`,
`system_message` (không phải media). Lọc bằng "có `url` https" là SAI vì
`ad_click` có `url` trỏ `facebook.com/<post_id>` và `link` trỏ bài viết — cả hai
còn mang `name` là nguyên văn bài quảng cáo, nên tên tệp thành 200 ký tự quảng
cáo nằm trong hồ sơ khách.

Nay dùng DANH SÁCH CHO PHÉP (`classifyAttachments`): chỉ loại thật là media mới
thành đính kèm. Loại mới của Pancake về sau sẽ bị bỏ qua chứ không lọt vào hồ sơ
khách — thà thiếu một loại media mới còn hơn để rác vào bệnh án.

**2. 429 tin (15%) hiện "[Tệp đính kèm]" hoặc "[Nội dung không đọc được]".**

Sale mở hộp thư thấy một dãy như vậy thì không biết khách gửi gì, phải mở
Pancake ra xem — đúng cái việc mà gom về CRM sinh ra để khỏi phải làm. Nay
`attachmentLabel` nói rõ: "[Hình ảnh]", "[Video]", "Đã bày tỏ cảm xúc ❤",
"Địa chỉ: …", "Khách nhắn từ quảng cáo".

**3. Video lưu sai tệp.** `url` của đính kèm video chỉ là ảnh đại diện `.jpg`;
tệp thật nằm ở `video_data.url`.

Dữ liệu đã đồng bộ về sai thì ĐỒNG BỘ LẠI KHÔNG CHỮA ĐƯỢC — luồng đồng bộ chống
trùng theo `externalId` nên bỏ qua tin đã có. Phải chạy
`npx tsx scripts/sua-du-lieu-pancake.ts --yes` (xem trước khi bỏ `--yes`).

### Gắn nhân viên muộn vẫn quy lại được số cũ

`senderUserId` chỉ điền được lúc GHI TIN, mà lúc đó nhân viên Pancake có thể
chưa gắn tài khoản CRM nào — chạy thật: 2.814 tin đã về, 19 nhân viên chưa ai
gắn. Nếu không quy lại thì mọi báo cáo của CRM (tốc độ trả lời, bảng điểm bộ
phận, lương thưởng) vẫn trống với toàn bộ số cũ và chỉ đếm từ lúc gắn trở đi.

Thêm cột `chat_messages.pancakeAgentUid` và `relinkAgentMessages`: gắn tài khoản
thì quy lại theo `uid` (chính xác), và theo `senderName` cho những tin về trước
khi có cột uid (Pancake ghi tên nhân viên vào `from.admin_name`). Bỏ gắn thì chỉ
xoá tin khớp `uid` — tin người đó gửi TỪ CRM cũng mang `senderUserId` nhưng
không có uid, xoá luôn là mất dữ liệu thật.

### Đối chiếu API thật — ba điểm tài liệu nói đúng

1. **Token đi bằng tham số URL, không có header `Authorization`.** Mặc định
   `PANCAKE_TOKEN_MODE` đổi thành `query`.
2. **Hai loại token, hai nhóm địa chỉ.** `access_token` của người dùng chỉ dùng
   cho `https://pages.fm/api/v1`; mọi API cấp trang nằm ở
   `https://pages.fm/api/public_api/v1` và `/v2`, chỉ nhận `page_access_token`.
3. **Giới hạn 5 lượt gọi/trang/giây** (`PANCAKE_PACE_MS`), và phản hồi gửi tin
   có thể trả HTTP 200 kèm `success: false`.

### Sáu điểm TÀI LIỆU NÓI SAI — mã nguồn đi theo API thật

Đã gọi thật vào tài khoản phòng khám ngày 08/10/2026 (4 trang Facebook, 206 ô số
liệu, 12 hội thoại). Sáu chỗ lệch, mỗi chỗ đều đủ để tính năng sai lặng lẽ:

| # | Tài liệu nói | API thật | Nếu tin tài liệu |
| --- | --- | --- | --- |
| 1 | `GET /pages` trả `categorized_pages` | trả `categorized` | Dò ra **0 trang**, cả tính năng chết lặng |
| 2 | Phải gọi `generate_page_access_token` | token nằm sẵn ở `settings.page_access_token` | Sinh token mới sẽ **vô hiệu token cũ**, làm đứt tích hợp khác của phòng khám |
| 3 | `average_response_time` là miligiây | là **giây** | Báo "TB phản hồi 0,44 giây" thay vì 7,3 phút |
| 4 | `hour` là UTC+0 | `hour` là giờ trang (UTC+7), `hour_in_integer` mới là UTC | Mọi mốc **lệch 7 tiếng**, số nhảy sang ngày khác |
| 5 | `GET messages` trả mới trước | trả **cũ trước** (12/12 hội thoại) | Đảo ngược thứ tự tin, xem trước và mốc khách chờ sai |
| 6 | `message` là nội dung tin | là **HTML**; `original_message` mới là văn bản sạch | Khách thấy `<div>…<br key='n_0' />` |

Căn cứ của điểm 3 và 4 (chốt bằng số, không phải phỏng đoán):

- `average_response_time` trên dữ liệu thật có trung vị **437**. Đọc là giây ra
  7,3 phút (hợp lý với người tư vấn); đọc là miligiây ra 0,44 giây (không người
  nào trả lời được).
- `hour` trừ `hour_in_integer` bằng **đúng 7 giờ ở cả 206/206 ô** — tức `hour`
  là giờ địa phương UTC+7, không phải UTC.

Các khẳng định này được chốt bằng test (`tests/pancake-hieu-suat.test.ts`, khối
"đọc đúng hình dạng API THẬT") với dữ liệu mẫu copy nguyên dạng từ tài khoản
thật — ai "sửa cho giống tài liệu" thì test đổ ngay.

Nhờ điểm 1 và 2, một lượt "Dò trang" lấy được cả ba thứ: danh sách trang, token
riêng từng trang, và danh sách nhân viên — không cần gọi thêm, không cần sinh
token mới.

## F36 · Báo cáo công việc hàng ngày từ trang tính Google

Tài liệu đầy đủ: **`docs/BAO-CAO-CONG-VIEC-TRANG-TINH.md`**.

**Vấn đề:** bốn bộ phận Media, MKT, Design, Content ghi báo cáo công việc trên
trang tính Google riêng của từng người (12 sheet `T1`..`T12` = 12 tháng). Muốn
biết tiến độ phải mở từng trang tính và đi nhắc mọi người gửi link.

**Chốt kiến trúc:** trang tính là dữ liệu nhân sự nên để **ẩn**, backend không
tự đọc được. Đường chính là **ĐẨY** — Apps Script nằm trong chính trang tính,
chạy bằng quyền của chủ trang tính:

| | Đẩy (mặc định) | Kéo (dự phòng) |
| --- | --- | --- |
| Trang tính ẩn | ✅ | ❌ |
| Lấy được URL ô "Link hoàn thành" | ✅ | ❌ (chỉ còn chữ "Link") |
| Cần cài ở trang tính | Dán mã một lần, chạy `setup()` | Không |
| Độ trễ | ~5 phút sau khi sửa | ≤30 phút (`work-report-pull`) |

Apps Script đẩy **mảng ô thô**, không đẩy dữ liệu đã phân tích: logic phân tích
nằm một chỗ trong CRM nên test được, và sửa mẫu không phải dán lại từng script.
`onEdit` chỉ ghi dấu "có sửa" rồi để trigger 5 phút đẩy — gọi mạng ngay trong
`onEdit` là tự hết quota UrlFetch của Google.

**Ba điểm của trang tính thật quyết định cách phân tích**

- Ô tiêu đề `🕒Time` và `Công/ngày` là **ô gộp** nên Google trả về rỗng, dò theo
  chữ không bao giờ ra. Mất cột ngày là mất cả màn theo dõi tiến độ, nên khi đã
  dò ra ≥3 cột theo tiêu đề thì các cột còn thiếu được vá theo vị trí mẫu.
- Ô ngày gộp theo khối việc nên ngày được **điền xuôi**; `Công/ngày` thì **không**
  — nó là số công của cả ngày, nhân ra từng dòng sẽ đếm sai. Số công tháng là
  giá trị **lớn nhất** vì ô đó tích luỹ.
- Ngày trống phải phân biệt: Chủ nhật để trắng là **nghỉ tuần**, ngày thường để
  trắng là **chưa điền báo cáo**. Đó chính là con số cần theo dõi.

**Ghi dữ liệu** = thay toàn bộ dòng của một sheet, không hợp nhất từng dòng:
chèn một dòng giữa tháng làm đổi số dòng của mọi dòng bên dưới.

**Bảo mật cổng đẩy:** `/api/work-reports/ingest` không qua phiên đăng nhập, xác
thực bằng token 32 byte riêng từng nguồn, **chỉ lưu hash SHA-256** như refresh
token. Token gắn với đúng một trang tính — dán mã của người này vào trang tính
người khác bị trả 409 chứ không âm thầm ghi sai chủ. Mỗi lần lấy mã là cấp token
mới và token cũ chết ngay.

**Phân quyền** — module E5: `work_report.read` (ALL/BRANCH/OWN),
`work_report.manage_source`, `work_report.sync`. Bộ phận mới: `MEDIA`, `MKT`,
`DESIGN`, `CONTENT` (bootstrap tạo ở mọi cơ sở). Vai trò mới `MEDIA`, `DESIGN`,
`CONTENT` chỉ thấy báo cáo của chính mình, không chạm dữ liệu y khoa, SĐT khách
bị che vì không có `customer.view_phone`. Bộ phận MKT dùng lại vai trò
`MARKETING` sẵn có. Trưởng bộ phận cần xem cả nhóm thì nâng scope lên `BRANCH`
ở màn Người dùng & Phân quyền.

**Hai tham số** phải đặt: `workReport.publicBaseUrl` (địa chỉ CRM mà Google gọi
tới — để trống thì lấy theo địa chỉ của chính yêu cầu, sai nếu đang mở qua
localhost) và `workReport.autoPull.enabled`.

**Kiểm chứng:** 22 test (`tests/f36-bao-cao-cong-viec.test.ts`) chạy trên bản
chụp **thật** sheet `T1` của trang tính mẫu — ai sửa bộ phân tích cho "gọn" mà
làm sai ô gộp thì test đổ ngay. Đã kéo thử toàn bộ 12 tháng của trang tính mẫu:
768 dòng việc, không lỗi, nhận cả kênh không lường trước (`FB Vân Trần`).

## Tham số mặc định chủ phòng khám phải xác nhận

Mọi con số kinh doanh là tham số trong **Cài đặt hệ thống** (`backend/src/lib/settings-catalog.ts`), sửa trên giao diện, có hiệu lực sau tối đa 15 giây. Các giá trị dưới đây là **mặc định do đội code đặt tạm hoặc lấy từ biên bản coaching**, chưa được chủ phòng khám chốt. Không dùng các con số này như số liệu chính thức trước khi xác nhận.

### Giá và giảm giá (F13, F21)

| Khoá | Mặc định | Ý nghĩa |
|---|---|---|
| `discount.capPercent.TELESALE` | 0 | Trần giảm ngoài ưu đãi của Telesale (%) |
| `discount.capPercent.TU_VAN_VIEN` | 0 | Trần giảm của Tư vấn viên (%) |
| `discount.capPercent.LE_TAN` | 0 | Trần giảm của Lễ tân (%) |
| `discount.capPercent.QUAN_LY_CO_SO` | 10 | Trần giảm của Quản lý cơ sở (%) |
| `discount.capPercent.GIAM_DOC` | 100 | Trần giảm của Giám đốc (%) |
| `pricing.singlePriceList` | false | Một bảng giá chung cho mọi cơ sở |
| Giá sàn dịch vụ NOVA | trống | Seed không đặt giá sàn; giá sàn chỉ là mốc tuyệt đối khi thấp hơn niêm yết |

### Chăm sóc, tái tiêm, bước bán hàng (F1, F9, F10)

| Khoá | Mặc định | Ý nghĩa |
|---|---|---|
| Số ngày tái tiêm (danh mục dịch vụ, `retreatDays`) | Filler 180; Botox gọn hàm, xoá nhăn, body 120; nhóm khác trống | Mốc tái tiêm, bác sĩ chỉnh từng lần được |
| `aftercare.milestones` | 0,1,3,7,14,30 | Mốc chăm sóc sau tiêm (ngày) |
| `followup.overdueDays` | 3 | Quá bao nhiêu ngày thì tính quá hạn liên hệ |
| `stage.returnWindowDays` | 180 | Làm dịch vụ lần 2 trong số ngày này thì sang Quay lại |
| `automation.unanswered.minutes` | 15 | Tin chưa trả lời bao lâu thì báo trưởng nhóm |
| `automation.stuckPhoto.days` | 3 | Kẹt ở bước Có ảnh bao lâu thì tạo việc chăm lại |
| `automation.noShow.minutes` | 30 | Quá giờ hẹn bao lâu chưa check-in thì tạo việc gọi lại |
| `automation.retreat.leadDays` | 7 | Tạo việc tái tiêm trước mốc bao nhiêu ngày |
| `automation.medicalKeywords` | đau, sưng, thuốc, biến chứng, bầm, dị ứng, thai, chảy máu, mưng mủ, sốt, tím, hoại tử, nhiễm trùng, cho con bú | Từ khoá y khoa (bác sĩ nên rà lại) |
| `inbox.waitingAlertMinutes` | 15 | Đồng hồ khách chờ chuyển đỏ |
| `inbox.slowReplyMinutes` | 60 | Ngưỡng trả lời chậm |

### Cọc và gửi tin (F11, F25)

| Khoá | Mặc định | Ý nghĩa |
|---|---|---|
| `deposit.defaultAmount` | 500.000đ | Tiền cọc gợi ý khi đặt lịch |
| `deposit.bankBin`, `deposit.bankAccountNo`, `deposit.bankAccountName` | trống | Tài khoản nhận cọc (phải khai tài khoản thật) |
| `broadcast.maxPerHour` | 60 | Số tin gửi theo nhóm tối đa mỗi giờ |
| `broadcast.facebookWindowHours` | 24 | Cửa sổ nhắn tin Facebook |

### Lương thưởng (F17), thi đua (F18), giới thiệu (F19)

| Khoá | Mặc định | Ý nghĩa |
|---|---|---|
| `payroll.salesRoles` | TELESALE, TU_VAN_VIEN | Vai tính lương cứng theo khách đến và thưởng doanh số |
| `payroll.baseSalaryDefault` | 7.000.000đ | Lương cứng bậc thấp nhất (≤ 100 khách đến) |
| `payroll.baseSalaryTiers` | >100: 8tr, >150: 10tr, >200: 13tr | Bậc lương cứng theo khách đến |
| `payroll.bonusScheme` | MILESTONE | Phương án thưởng: mốc hoặc % bậc (chủ chọn một) |
| `payroll.bonusMilestones` | 300tr: 1tr, 500tr: 3tr, 1.000tr: 10tr | Phương án mốc |
| `payroll.bonusPercentTiers` | 100tr: 1%, 200tr: 1,5%, 300tr: 3%, 500tr: 4% | Phương án % bậc |
| `payroll.revenueUnitVnd` | 1.000.000 | Đơn vị mốc doanh thu |
| `payroll.fullSalePercent` | 100% | Bán full: phần doanh thu tính cho sale |
| `payroll.partialSalePercent` | **50%** | Bán phần (sale kéo đến, bác sĩ chốt): phần doanh thu tính cho sale |
| `payroll.doctorCloseBonusPercent` | 0% | Thưởng bác sĩ chốt trong bán phần |
| `payroll.upsellPercent` | 3% | Upsale cho kỹ thuật viên |
| `payroll.adsPercentTiers` | 1 tỷ: 0,5%; 1,5 tỷ: 0,8%; 2,5 tỷ: 1%; 5 tỷ: 1,2%; 7 tỷ: 1,5%; 10 tỷ: 1,8% | % cho người chạy ads theo doanh thu quảng cáo Facebook |
| `payroll.adsRoles`, `payroll.adsChannelKeys` | MARKETING; facebook, messenger, instagram | Ai là người chạy ads, kênh nào tính là quảng cáo Facebook |
| `contest.monthlyShowupTarget` | **0** (chưa đặt) | Mục tiêu khách đến tháng của cả đội |
| `referral.rewardKind` | VOUCHER | Thưởng giới thiệu bằng voucher hay tiền |
| `referral.rewardAmount` | **500.000đ** | Giá trị thưởng giới thiệu |
| `referral.voucherValidDays` | **90 ngày** | Hạn dùng voucher thưởng |
| `commission.holdDays` | 30 | Giữ hoa hồng trước khi chi |

### Báo cáo và AI

| Khoá | Mặc định | Ý nghĩa |
|---|---|---|
| `report.responseFastMinutes`, `report.responseSlowMinutes` | 5, 30 | Nhóm tốc độ phản hồi đầu tiên (F31) |
| `retention.dueSoonDays` | 14 | Danh sách sắp đến hạn tái tiêm |
| `ai.scoringBatchSize` | 50 | Số hội thoại chấm mỗi lượt (AI4) |
| `ai.reengageSilentDays` | 30 | Khách im lặng bao lâu thì soạn nháp chăm lại (AI5) |
| `ai.reengageDailyLimit` | 30 | Số nháp tối đa mỗi ngày (AI5) |
| `ai.reengageCooldownDays` | 30 | Không soạn lại cho cùng khách trong bao lâu (AI5) |
| `ai.briefingHour` | 7 | Giờ gửi bản tin sáng (AI6) |
| `security.loginMaxAttempts`, `security.loginLockMinutes` | 5, 15 | Khoá tạm tài khoản khi sai mật khẩu |
| `surgery.minDepositPercent` | 30 | Cọc tối thiểu để xác nhận ca (chế độ phẫu thuật) |

### Quyết định vận hành đội code đã tự chọn (cần chủ xác nhận)

- **Báo giá từ phác đồ (F30)** dùng giá niêm yết, không giảm. Số lượng lên báo giá mặc định là liều làm tròn lên đơn vị nguyên (1,5cc thành 2), tên dòng ghi liều thật; người lập sửa được số lượng trên phiếu. Nếu phòng khám bán filler theo 0,5cc thì cần đổi đơn vị giá trong bảng giá.
- **Thư viện case (F30)**: case cần hai cổng duyệt (chuyên môn do bác sĩ, truyền thông do quản lý, giám đốc) mới hiện cho sale. Nhãn ẩn danh ghi giới và nhóm 5 tuổi ("Nữ, 30 đến 34 tuổi").
- **AI5**: nháp chưa ai duyệt sau 7 ngày thì hết hạn. Nháp chỉ soạn cho khách đã đồng ý xử lý dữ liệu bằng AI và không từ chối nhận tin.
- **AI6**: bản tin toàn hệ thống gửi Giám đốc và Quản trị hệ thống; bản từng cơ sở gửi Quản lý cơ sở (khi có từ 2 cơ sở).
- Quyền mới: Giám đốc, Quản lý cơ sở được lập phiếu tư vấn; Bác sĩ được duyệt cổng chuyên môn của case.

## Việc cần xác minh với tài khoản thật

1. **Pancake**: đường dẫn API, hai loại token và mốc thời gian đã đối chiếu bản OpenAPI chính thức (xem mục F35). Còn phải thử với tài khoản thật: định dạng chữ ký webhook (`X-Pancake-Signature` HMAC-SHA256 hay bí mật chung — các chỗ `TODO-VERIFY` còn lại ở `backend/src/routes/pancake.ts`), trường nguồn quảng cáo (ad_id, post_id, campaign), cách tải ảnh đính kèm, và xác nhận `GET /pages/{page_id}/statistics/users` có trong gói thuê bao của phòng khám.
2. **Zalo OA**: kết nối OA thật, thử webhook nhận tin, gửi tin, tải ảnh.
3. **Facebook qua Pancake**: xác nhận quy tắc cửa sổ 24 giờ áp đúng với tin gửi qua Pancake.
4. **Claude API**: đặt `ANTHROPIC_API_KEY` thật, kiểm tên model `claude-haiku-4-5-20251001` (CHEAP) và `claude-sonnet-5` (SMART) trong `backend/src/lib/ai.ts` có trong tài khoản; chạy thử AI1 đến AI6 với khách đã ký đồng ý xử lý dữ liệu; theo dõi chi phí.
5. **VietQR**: quét mã với tài khoản ngân hàng thật của từng cơ sở, xác nhận nội dung chuyển khoản là mã lịch.
6. **Meta, TikTok**: xuất CSV chi phí thật, nhập thử ở Đo lường (tên cột có thể khác mẫu đã dựng).
7. **Misa**: xác nhận cột số hoá đơn và định dạng tệp xuất kế toán với kế toán.
8. **Điện thoại**: cài bản web như app trên iPhone và Android thật qua HTTPS (service worker cần HTTPS hoặc localhost), thử hộp thư một cột, chụp ảnh trước bằng camera máy tính bảng.
9. **Sao lưu**: cài cron hằng ngày trên máy chủ thật, thử khôi phục một bản, cất khoá mã hoá riêng.
10. **Dữ liệu cũ**: chạy `scripts/migrate-stages.ts` và nhập Excel khách cũ trên bản sao CSDL trước.
