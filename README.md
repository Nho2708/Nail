# Lumière Nail Studio — Website xem mẫu & đặt lịch làm nail

Website có 2 giao diện:

- **Khách hàng** (`/`): xem bộ sưu tập mẫu nail (lọc theo danh mục và màu sơn), xem ảnh lớn / phóng to, thử màu trên **mô hình 3D** (màu, hiệu ứng bóng / lì / tráng gương / mắt mèo, dáng móng, đầu French), đặt lịch hoặc yêu cầu tư vấn **không cần đăng nhập** (có kiểm tra dữ liệu). Khách có tài khoản chỉ cần chọn mẫu rồi bấm *Đặt lịch* hoặc *Tư vấn*, thông tin liên hệ lấy tự động từ tài khoản.
- **Quản trị** (`/admin`, chỉ tài khoản quyền admin): thống kê lượt truy cập, quản lý lịch hẹn, mẫu nail, màu sơn, danh mục, dịch vụ, khách hàng & phân quyền, chỉnh **giao diện trang đặt lịch** (logo & biểu tượng tab, màu, font, bo góc, nội dung, ảnh, bật/tắt từng phần, có xem trước trực tiếp) và cấu hình **thông báo về Zalo OA / Messenger / Telegram / Webhook**.

Giao diện được thiết kế lại theo bố cục của renai.beauty (theo phong cách sang trọng tối giản) bằng skill `ui-ux-pro-max`, dùng phong cách Soft UI với font Playfair Display và Be Vietnam Pro.

## Công nghệ

- Node.js ≥ 22.13 (đã test với 24), Express 4
- **SQL Server 2019** (driver `mssql`)
- Giao diện: HTML, CSS và JavaScript thuần (ES modules), Three.js cho phần 3D, Chart.js cho thống kê
- `sharp` để tự tối ưu ảnh tải lên (chuyển sang WebP và tạo ảnh thu nhỏ)

## Cài đặt

```bash
npm install
```

### 1. Tạo database (SQL Server 2019)

```bash
# Tạo database NailStudio + các bảng (chạy lại được nhiều lần, KHÔNG có dữ liệu mẫu)
sqlcmd -S QUANG-NHO\PRN222 -U sa -P <mat-khau-sa> -i database\01_schema.sql
```

Tùy chọn: tạo SQL login riêng cho ứng dụng thay vì dùng `sa` (chỉ có quyền đọc/ghi dữ liệu):

```bash
sqlcmd -S QUANG-NHO\PRN222 -U sa -P <mat-khau-sa> -i database\02_app_login.sql -v AppPassword="MatKhauManh_123"
```

SQL Server cần bật **TCP/IP**, dịch vụ **SQL Server Browser** (khi kết nối bằng tên instance) và chế độ **Mixed Mode Authentication**.

### 2. Cấu hình

```bash
copy .env.example .env   # rồi điền DB_SERVER, DB_USER, DB_PASSWORD
```

`DB_SERVER` nhận dạng `TEN_MAY\TEN_INSTANCE` (ví dụ `QUANG-NHO\PRN222`) hoặc `localhost` kèm `DB_PORT`.

### 3. Chạy

```bash
npm start        # http://localhost:3000   ·   quản trị: http://localhost:3000/admin
```

Lần chạy đầu tiên, hệ thống tạo tài khoản admin từ `ADMIN_EMAIL` / `ADMIN_PASSWORD` trong `.env`. Hãy đổi mật khẩu ở mục **Tài khoản admin** sau khi đăng nhập.

## Bắt đầu sử dụng (database trống)

Database không có dữ liệu mẫu. Sau khi đăng nhập admin, nên tạo theo thứ tự:

1. **Danh mục mẫu** (French, Sơn gel trơn, Mắt mèo…)
2. **Màu sơn** (tên, mã màu, hiệu ứng): dùng để lọc mẫu và cho phần thử màu 3D
3. **Dịch vụ** (giá từ, thời lượng): khách chọn khi đặt lịch
4. **Mẫu nail** (tải ảnh, gán danh mục và màu, giá, đánh dấu nổi bật)
5. **Thiết kế giao diện**: tên tiệm, số điện thoại, địa chỉ, giờ mở cửa, số Zalo, username Messenger…
6. **Thông báo**: nhập token Zalo OA / Messenger / Telegram rồi bấm *Gửi tin thử*

## Thông báo lịch hẹn cho admin

Mỗi lịch hẹn hoặc yêu cầu tư vấn mới sẽ:

- được gửi tới mọi kênh đã cấu hình: **Zalo OA API v3** (tin tư vấn tới `user_id` của admin đã quan tâm OA), **Messenger Send API** (tới PSID của admin, trong cửa sổ 24 giờ), **Telegram Bot** hoặc **Webhook** (Zapier, Make, n8n…). Kết quả gửi hiện ở cột *Báo admin* trong danh sách lịch hẹn;
- hiện thông báo trong trang quản trị (tự kiểm tra mỗi 20 giây, có thể bật thông báo trình duyệt bằng biểu tượng chuông);
- ở phía khách, màn hình xác nhận có nút **Gửi qua Zalo** và **Gửi qua Messenger** để khách nhắn trực tiếp cho tiệm. Nội dung lịch hẹn được sao chép sẵn, riêng Messenger được điền sẵn.

## Cấu trúc

```
server.js              API + phục vụ file tĩnh
src/db.js              kết nối SQL Server, cài đặt mặc định, tạo admin đầu tiên
src/validate.js        kiểm tra dữ liệu đặt lịch / đăng ký (khớp với phía client)
src/notify.js          gửi thông báo Zalo / Messenger / Telegram / Webhook
src/security.js        mã hóa mật khẩu (scrypt), token phiên, giới hạn số lần gửi
database/*.sql         script tạo database SQL Server 2019
public/index.html      trang khách hàng     public/js/site.js, nail3d.js
public/admin/          trang quản trị
```

## Bảo mật

- Mật khẩu mã hóa bằng scrypt kèm salt. Phiên đăng nhập lưu trong database, cookie `HttpOnly` và `SameSite=Lax`.
- Phân quyền ở phía server: mọi API `/api/admin/*` và trang `/admin` đều yêu cầu quyền admin.
- Mọi truy vấn SQL đều dùng tham số. Nội dung do người dùng nhập được escape trước khi hiển thị.
- Ảnh tải lên được mã hóa lại bằng sharp (xóa metadata, giới hạn kích thước).
- Giới hạn số lần đăng nhập, đặt lịch và ghi nhận truy cập theo IP. Một khung giờ chỉ nhận tối đa số khách đã cấu hình (kiểm tra trong transaction).
