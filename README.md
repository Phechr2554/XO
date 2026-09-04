# XO Arena

XO Arena เป็นเว็บเกม XO/Tic-Tac-Toe + Gomoku ที่รองรับ AI, เกม 2 คนในเครื่อง, จับคู่ออนไลน์ด้วย Elo, ห้องส่วนตัว, แชท และ PWA

## Run locally
```bash
npm install
npm start
```
เปิด `http://localhost:3000`

## Deploy บน Bot-Hosting.net
ใช้ deployment แบบ **Application → Node.js** และให้โปรเจกต์อยู่ที่ root โดยมี `package.json` และ `server.js` อยู่ระดับเดียวกัน ระบบติดตั้ง dependency จาก `package.json` และตั้ง Startup Entry File เป็น `server.js` หรือ Start Command เป็น `npm start` ตามหน้าตั้งค่าของ deployment. แอปอ่านพอร์ตจาก `PORT`/`SERVER_PORT`/`APP_PORT` และมี fallback เป็นพอร์ต `25118` เพื่อรองรับ deployment ที่ไม่ได้ inject ตัวแปรพอร์ต และใช้ Socket.IO จาก origin เดียวกับเว็บ


## Authentication & persistence (v2.1)
- `data/accounts.jsonl`: one account per line; stores `id`, `name`, `passwordHash` (scrypt), and creation time. Passwords are never stored as plain text.
- `data/data.jsonl`: one player per line; stores avatar, Elo, game totals, settings, achievements, history, and other non-password data.
- Login uses an `HttpOnly` session cookie. Socket.IO trusts only the authenticated session, not a client-supplied player ID.
- Private room join/create is guarded against joining a second room, duplicate queue entries, stale reconnect timers, and player identity spoofing.
