# XO Arena

XO Arena เป็นเว็บเกม XO/Tic-Tac-Toe + Gomoku ที่รองรับ AI, เกม 2 คนในเครื่อง, จับคู่ออนไลน์ด้วย Elo, ห้องส่วนตัว, แชท และ PWA

## Run locally
```bash
npm install
npm start
```
เปิด `http://localhost:3000`

## Deploy บน Bot-Hosting.net
ใช้ deployment แบบ **Application → Node.js** และให้โปรเจกต์อยู่ที่ root โดยมี `package.json` และ `server.js` อยู่ระดับเดียวกัน ระบบติดตั้ง dependency จาก `package.json` และตั้ง Startup Entry File เป็น `server.js` หรือ Start Command เป็น `npm start` ตามหน้าตั้งค่าของ deployment. แอปอ่านพอร์ตจาก `process.env.PORT` เพื่อรองรับพอร์ตของแพลตฟอร์ม และใช้ Socket.IO จาก origin เดียวกับเว็บ
