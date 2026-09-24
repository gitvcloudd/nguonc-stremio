# NguonC Stremio Addon (Render)

Stream provider cho Stremio – nguồn phim.nguonc.com.

## Deploy lên Render (free)

1. Tạo repo GitHub mới (public hoặc private đều được).
2. Upload toàn bộ nội dung thư mục này lên repo (hoặc push bằng git).
3. Trên Render → **New Web Service** → chọn repo vừa tạo.
4. Cấu hình:
   - **Name**: `nguonc-stremio` (tuỳ ý)
   - **Runtime**: Node
   - **Build Command**: để trống (hoặc `npm install` nếu Render yêu cầu)
   - **Start Command**: `npm start`
   - **Instance Type**: Free
5. Create Web Service → đợi deploy xong.
6. Lấy URL dạng `https://nguonc-stremio-xxxx.onrender.com/manifest.json`
7. Dán vào Stremio → Addons → Install from URL.

## Debug

```
https://<your-render-url>/debug?id=tt0111161&type=movie
```

## Lưu ý free tier

- Render free sẽ sleep sau ~15 phút không có request.
- Lần mở Stremio đầu tiên có thể chậm 30–60s (cold start).
- Sau khi warm thì bình thường.
