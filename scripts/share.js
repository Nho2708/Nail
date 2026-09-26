// Opens a temporary public HTTPS link (Cloudflare Quick Tunnel) to the local site.
// Usage: npm start  (in one terminal), then  npm run share  (in another).
// The link changes every time this script restarts; use a named tunnel + own domain for a fixed link.
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const port = process.env.PORT || 3000;
const candidates = [
  process.env.CLOUDFLARED,
  path.join(process.env.LOCALAPPDATA || '', 'cloudflared', 'cloudflared.exe'),
].filter(Boolean);

let bin = candidates.find((p) => fs.existsSync(p));
if (!bin) {
  try {
    execSync(process.platform === 'win32' ? 'where cloudflared' : 'command -v cloudflared', { stdio: 'ignore' });
    bin = 'cloudflared';
  } catch {
    console.error('Không tìm thấy cloudflared. Tải tại: https://github.com/cloudflare/cloudflared/releases (bản windows-amd64.exe)');
    console.error('rồi đặt vào %LOCALAPPDATA%\\cloudflared\\cloudflared.exe hoặc thêm vào PATH.');
    process.exit(1);
  }
}

const child = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
let shown = false;
const onData = (buf) => {
  const m = !shown && String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (m) {
    shown = true;
    console.log(`\n  Link xem thử (giữ cửa sổ này mở):  ${m[0]}\n  Trang quản trị:                    ${m[0]}/admin\n`);
  }
};
child.stdout.on('data', onData);
child.stderr.on('data', onData);
child.on('exit', (code) => process.exit(code ?? 0));
process.on('SIGINT', () => child.kill());
