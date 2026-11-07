# VPN Mode — POC

Biến AgentProxy từ "bộ local HTTP proxy" thành **VPN toàn hệ thống**: bật toggle
→ mọi app trên máy (kể cả app không biết dùng proxy) có traffic đi qua tunnel
và ra internet từ exit của proxy upstream.

Branch POC: `poc/vpn-mode` (git worktree `electron-app-vpn-poc`), mọi thay đổi
đều additive — không đụng `proxy-manager` / `proxy-engine` / renderer `app.js`.

## Kiến trúc

```
apps bất kỳ ──► TUN adapter ──► sing-box ──► http://127.0.0.1:8801 ──► upstream ──► internet
   (toàn bộ)    (wintun,          (tun2socks)   (local proxy có sẵn     (UrbanVPN /
                 admin)                          của app)                Proton/pool)
```

- **sing-box 1.14.4** (binary Go duy nhất, kèm `libcronet.dll`) làm data-plane:
  TUN inbound + auto_route (tự thêm route mặc định, tự chống routing-loop)
  + outbound HTTP trỏ về proxy #1 của app + fake-IP DNS (không bao giờ cần
  resolve DNS thật phía client — CONNECT mang hostname, upstream resolve).
- **wintun driver**: sing-box ≥1.10 đã embed, không cần DLL riêng.
- **Điều khiển**: `lib/vpn-engine.js` sinh config → validate bằng
  `sing-box check` → UAC (#1) khởi động → poll clash API `127.0.0.1:9090`
  để biết tunnel thật sự UP → UAC (#2) khi tắt.

## An toàn (đã cài trong config, xem `lib/vpn-engine.js → buildConfig()`)

| Rail | Ý nghĩa |
|---|---|
| `process_name` direct cho `electron.exe`/`AgentProxy.exe`/`node.exe` | connection của app tới upstream proxy KHÔNG quay lại vào tunnel → không loop, không double-tunnel |
| `ip_is_private` → direct | LAN/máy in/localhost subnet vẫn đi bình thường |
| `strict_route: false` | POC không có kill-switch: sing-box chết → traffic rơi về network bình thường (không khóa máy) |
| fake-IP DNS + sniff | không rò DNS ra ngoài tunnel (mọi query port 53 bị hijack) |

Giới hạn đã biết: **UDP không đi qua được HTTP CONNECT proxy** (game/VoIP/QUIC
chết khi VPN ON; browser vẫn OK vì fallback TCP). Tốc độ = tốc độ upstream.

## Chạy thử

```bash
node vpn/fetch-singbox.js        # tải sing-box 1.14.4 (verify sha256 pinned)
npm start                        # mở app → card "VPN Mode (POC)" ở trên bảng proxy

# e2e headless không cần UI (2 lần UAC):
node tools/vpn-poc-smoke.js --upstream host:port:user:pass
```

Thứ tự trong app: **Connect** (proxies) trước → **Start VPN** sau. Tắt thì
Stop VPN trước, Disconnect sau.

## Bản production sẽ khác gì (phase sau)

- sing-box chạy như **Windows Service** — UAC đúng 1 lần lúc cài, toggle
  không còn prompt (mô hình Proton/Mullvad: UI thường + daemon admin).
- Kill switch thật (strict_route/WFP), split tunneling per-app, chọn proxy
  nào làm exit (location list).
