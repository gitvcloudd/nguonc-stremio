# NguonC Stremio Addon (Render)

Nguồn phim.nguonc.com cho Stremio.

## Deploy lên Render

1. Tạo Web Service từ repository này, chọn runtime Node và Start Command `npm start`.
2. Sau khi deploy thành công, cài `https://<your-render-url>/manifest.json` trong Stremio.
3. Dùng `npm test` để chạy bài kiểm tra đường đi HLS ở máy phát triển.

## Đường đi HLS từ v1.0.6

Render tìm nguồn, giải mã playlist StreamC và loại các đoạn quảng cáo đã biết. Playlist trả về chứa URL tuyệt đối để trình phát tải video và khóa HLS trực tiếp từ CDN. Render không nhận tải hộ các đoạn video. Điều này giảm tải cho Render và tránh lỗi nhận nhầm video `.html` là playlist rồi tải hai lần.

Nếu máy hoặc ứng dụng phát không truy cập trực tiếp được CDN, playlist vẫn trả về thành công nhưng phim có thể không chạy. Kiểm tra URL đoạn phim trên thiết bị phát trước khi thay đổi đường đi này.

## Chẩn đoán

`https://<your-render-url>/debug?id=tt0111161&type=movie` kiểm tra tìm nguồn và giải mã playlist. Log `HLS_PLAYLIST` báo thời gian xử lý playlist bằng mili giây, số đoạn và lỗi (nếu có). Một kết quả `decryptTest.ok` chỉ xác nhận playlist, chưa xác nhận thiết bị phát lấy được video trực tiếp từ CDN.

Render Free tạm dừng dịch vụ sau 15 phút không có lưu lượng đến; lượt mở đầu sau khi nghỉ có thể mất khoảng một phút để khởi động. Thời gian này tách biệt với thời gian tải video khi dịch vụ đã hoạt động.
