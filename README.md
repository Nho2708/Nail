# Nail Art Studio — Website xem mẫu & đặt lịch làm nail

Website có 2 giao diện:

- **Khách hàng** (`/`): xem bộ sưu tập mẫu nail (lọc theo danh mục và màu sơn), xem ảnh lớn / phóng to, thử màu trên **mô hình 3D** (màu, hiệu ứng bóng / lì / tráng gương / mắt mèo, dáng móng, đầu French), đặt lịch hoặc yêu cầu tư vấn **không cần đăng nhập** (có kiểm tra dữ liệu). Khách có tài khoản chỉ cần chọn mẫu rồi bấm *Đặt lịch* hoặc *Tư vấn*, thông tin liên hệ lấy tự động từ tài khoản.
- **Quản trị** (`/admin`, chỉ tài khoản quyền admin): thống kê lượt truy cập, quản lý lịch hẹn, mẫu nail, màu sơn, danh mục, dịch vụ, khách hàng & phân quyền, chỉnh **giao diện trang đặt lịch** (logo & biểu tượng tab, màu, font, bo góc, nội dung, ảnh, bật/tắt từng phần, có xem trước trực tiếp) và cấu hình **thông báo về Zalo OA / Messenger / Telegram / Webhook**.

## Công nghệ

- Node.js ≥ 22.13 (đã test với 24), Express 4
- **PostgreSQL** (driver `pg`), chạy tốt trên Neon, Supabase hoặc PostgreSQL cài trên máy
- Giao diện: HTML, CSS và JavaScript thuần (ES modules), Three.js cho phần 3D, Chart.js cho thống kê
- `sharp` để tối ưu ảnh tải lên (WebP + ảnh thu nhỏ). **Ảnh được lưu trong database**, nên host không có ổ đĩa cố định (như Render bản miễn phí) vẫn giữ được ảnh.

## Host miễn phí: Render + Neon + UptimeRobot

| Phần | Dịch vụ | Gói miễn phí |
|---|---|---|
| Web | [Render](https://render.com) | 750 giờ/tháng, đủ chạy 1 web liên tục |
| Database | [Neon](https://neon.com) PostgreSQL | 100 CU-giờ/tháng, 0.5 GB, tự ngủ sau 5 phút không dùng |
| Giữ web thức | [UptimeRobot](https://uptimerobot.com) | gọi `/healthz` mỗi 5 phút để Render không tắt web |

Ứng dụng được viết để tiết kiệm giờ chạy của Neon: `/healthz` không đụng tới database; cài đặt và danh mục được ghi nhớ trong bộ nhớ; lượt truy cập được gom lại và ghi 30 phút một lần; trang quản trị chỉ kiểm tra lịch mới khi tab đang mở.

### Bước 1 — Tạo database trên Neon
1. Đăng ký tại neon.com (đăng nhập bằng GitHub hoặc Google).
2. **Create project**, chọn region **AWS Asia Pacific (Singapore)**, PostgreSQL bản mới nhất.
3. Ở **Connect**, bật **Connection pooling** và sao chép chuỗi kết nối dạng
   `postgresql://user:password@ep-xxx-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`.

Không cần tự tạo bảng: server tự chạy `database/schema.sql` mỗi lần khởi động (chạy lại không mất dữ liệu).

### Bước 2 — Deploy lên Render
1. Đăng ký tại render.com bằng tài khoản GitHub có repo này.
2. **New → Blueprint**, chọn repo. Render đọc file `render.yaml` (gói free, region Singapore, health check `/healthz`).
3. Điền các biến môi trường được hỏi:
   - `DATABASE_URL`: chuỗi kết nối Neon ở bước 1
   - `ADMIN_EMAIL`, `ADMIN_PASSWORD`: tài khoản admin đầu tiên (chỉ dùng khi database chưa có admin)
4. Deploy xong, web chạy tại `https://<tên-service>.onrender.com`. Mỗi lần đẩy code lên GitHub, Render tự cập nhật.

### Bước 3 — Giữ web luôn thức
Trên UptimeRobot: **New monitor → HTTP(s)**, URL `https://<tên-service>.onrender.com/healthz`, chu kỳ **5 phút**.
Không có bước này, Render tắt web sau 15 phút không có khách và khách tiếp theo phải chờ khoảng 1 phút.

### Tên miền riêng (tùy chọn)
Mua tên miền (ví dụ `iyunail.com`), rồi trong Render: **Settings → Custom Domains** và thêm bản ghi DNS theo hướng dẫn. Render cấp HTTPS miễn phí.

## Chạy trên máy (phát triển)

```bash
npm install
copy .env.example .env   # điền DATABASE_URL (có thể dùng luôn database Neon, hoặc tạo một branch riêng trên Neon để thử)
npm start                # http://localhost:3000   ·   quản trị: http://localhost:3000/admin
```

Nếu dùng PostgreSQL cài trên máy, tạo database với mã hóa UTF-8:
`CREATE DATABASE nailstudio ENCODING 'UTF8' TEMPLATE template0;`

Tạo link xem thử công khai tạm thời (Cloudflare Quick Tunnel, đổi địa chỉ mỗi lần chạy): mở cửa sổ thứ hai và chạy `npm run share`.

## Bắt đầu sử dụng (database trống)

Database không có dữ liệu mẫu. Sau khi đăng nhập admin, nên tạo theo thứ tự:

1. **Danh mục mẫu** (French, Sơn gel trơn, Mắt mèo…)
2. **Màu sơn** (tên, mã màu, hiệu ứng): dùng để lọc mẫu và cho phần thử màu 3D
3. **Menu dịch vụ** (Thiết kế giao diện → Menu dịch vụ): tải ảnh bảng giá đầy đủ, thêm các dịch vụ theo nhóm (tên, giá, thời lượng), sắp xếp, chọn ảnh nằm bên trái hay phải. Khách bấm "Đặt" ở từng dịch vụ để đặt lịch; danh sách này cũng là ô chọn dịch vụ trong form đặt lịch
4. **Mẫu nail** (tải ảnh, gán danh mục và màu, giá, đánh dấu nổi bật)
5. **Thiết kế giao diện**: logo, tên tiệm, số điện thoại, địa chỉ, giờ mở cửa, số Zalo, username Messenger…
6. **Thông báo**: nhập token Zalo OA / Messenger / Telegram rồi bấm *Gửi tin thử*

## Thông báo lịch hẹn cho admin

Mỗi lịch hẹn hoặc yêu cầu tư vấn mới sẽ:

- được gửi tới mọi kênh đã cấu hình: **Zalo OA API v3** (tin tư vấn tới `user_id` của admin đã quan tâm OA), **Messenger Send API** (tới PSID của admin, trong cửa sổ 24 giờ), **Telegram Bot** hoặc **Webhook** (Zapier, Make, n8n…). Kết quả gửi hiện ở cột *Báo admin* trong danh sách lịch hẹn;
- hiện thông báo trong trang quản trị (tự kiểm tra mỗi phút khi tab đang mở, có thể bật thông báo trình duyệt bằng biểu tượng chuông);
- ở phía khách, màn hình xác nhận có nút **Gửi qua Zalo** và **Gửi qua Messenger** để khách nhắn trực tiếp cho tiệm.

## Cấu trúc

```
server.js              API + phục vụ file tĩnh
src/db.js              kết nối PostgreSQL, cài đặt mặc định (có cache), tạo admin đầu tiên
src/images.js          lưu / phục vụ ảnh tải lên từ database (/img/<id>), dọn ảnh không còn dùng
src/analytics.js       gom lượt truy cập trong bộ nhớ và ghi theo đợt
src/validate.js        kiểm tra dữ liệu đặt lịch / đăng ký (khớp với phía client)
src/notify.js          gửi thông báo Zalo / Messenger / Telegram / Webhook
src/security.js        mã hóa mật khẩu (scrypt), token phiên, giới hạn số lần gửi
database/schema.sql    cấu trúc database PostgreSQL (không có dữ liệu mẫu)
render.yaml            cấu hình deploy Render (Blueprint)
public/index.html      trang khách hàng     public/js/site.js, nail3d.js
public/admin/          trang quản trị
```

## Bảo mật

- Mật khẩu mã hóa bằng scrypt kèm salt. Phiên đăng nhập lưu trong database, cookie `HttpOnly`, `SameSite=Lax`, và `Secure` khi `NODE_ENV=production`.
- Phân quyền ở phía server: mọi API `/api/admin/*` và trang `/admin` đều yêu cầu quyền admin.
- Mọi truy vấn SQL đều dùng tham số. Nội dung do người dùng nhập được escape trước khi hiển thị.
- Ảnh tải lên được mã hóa lại bằng sharp (xóa metadata, giới hạn kích thước).
- Giới hạn số lần đăng nhập, đặt lịch và ghi nhận truy cập theo IP. Một khung giờ chỉ nhận tối đa số khách đã cấu hình (khóa theo khung giờ trong transaction).
- Nếu không đặt `ADMIN_PASSWORD`, mật khẩu admin đầu tiên được tạo ngẫu nhiên và in ra log một lần.
