# XO Arena

XO Arena เป็นเว็บเกม XO/Tic-Tac-Toe + Gomoku ที่รองรับ AI, เกม 2 คนในเครื่อง, จับคู่ออนไลน์ด้วย Elo, ห้องส่วนตัว, แชท และ PWA

## Run locally
```bash
npm install
npm start
```
เปิด `http://localhost:3000`

## ระบบสมาชิก
ระบบบังคับสมัครสมาชิก/เข้าสู่ระบบก่อนเริ่มเล่น โดยใช้ชื่อผู้ใช้ + รหัสผ่าน
- `data/users.jsonl` เก็บข้อมูลบัญชี: id, ชื่อผู้ใช้ และรหัสผ่านแบบ hash (scrypt) เท่านั้น
- `data/player_data.jsonl` เก็บข้อมูลอื่นของสมาชิก เช่น avatar, Elo, สถิติ, achievements, history และ settings โดยไม่เก็บชื่อผู้ใช้หรือรหัสผ่าน
- รูปแบบ JSONL: 1 บรรทัด = 1 คน
- session token ใช้สำหรับเชื่อมต่อ Socket.IO และหมดอายุหลังไม่มีการใช้งานตามอายุ session

## ห้องออนไลน์
เซิร์ฟเวอร์จะบังคับให้สมาชิกหนึ่งคนมี socket หลักเพียงหนึ่งตัว, ล้างคิว/ห้องเดิมก่อนสร้างหรือเข้าห้องใหม่, ป้องกันการเพิ่มผู้ชมซ้ำ และตรวจสอบการกลับเข้าเกมเดิมเพื่อลดปัญหาห้องค้าง/เข้าผิดห้อง

## Deploy บน Bot-Hosting.net
ใช้ deployment แบบ **Application → Node.js** และให้โปรเจกต์อยู่ที่ root โดยมี `package.json` และ `server.js` อยู่ระดับเดียวกัน ระบบติดตั้ง dependency จาก `package.json` และตั้ง Startup Entry File เป็น `server.js` หรือ Start Command เป็น `npm start` ตามหน้าตั้งค่าของ deployment. แอปอ่านพอร์ตจาก `PORT`/`SERVER_PORT`/`APP_PORT` และมี fallback เป็นพอร์ต `25118` เพื่อรองรับ deployment ที่ไม่ได้ inject ตัวแปรพอร์ต และใช้ Socket.IO จาก origin เดียวกับเว็บ

## URL หลัก
- `/` = Dashboard / เกมเท่านั้น
- `/Login` = หน้าเข้าสู่ระบบ
- `/SignUp` = หน้าสมัครสมาชิก
