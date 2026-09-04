(function () {
  'use strict';

  const STORE_KEY = 'xo-arena-v2';
  const DEFAULT_STATE = { auth: { token: '', userId: '' }, profile: { id: '', name: '', avatar: '🐱', elo: 1000 } };

  function readState() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
      return {
        ...DEFAULT_STATE,
        ...raw,
        auth: { ...DEFAULT_STATE.auth, ...(raw.auth || {}) },
        profile: { ...DEFAULT_STATE.profile, ...(raw.profile || {}) }
      };
    } catch {
      return structuredClone(DEFAULT_STATE);
    }
  }

  function writeAuth(token, profile) {
    const state = readState();
    state.auth = { token: String(token || ''), userId: String(profile?.id || '') };
    state.profile = { ...state.profile, id: profile?.id || '', name: profile?.name || '', avatar: profile?.avatar || '🐱', elo: profile?.elo ?? 1000 };
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  }

  function clearAuth() {
    const state = readState();
    state.auth = { token: '', userId: '' };
    state.profile = { ...state.profile, id: '', name: '', elo: 1000 };
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  }

  function redirectHome() {
    const params = new URLSearchParams(location.search);
    const room = params.get('room');
    location.replace(room ? '/?room=' + encodeURIComponent(room) : '/');
  }

  async function request(url, payload) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
      body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'ดำเนินการไม่สำเร็จ');
    return data;
  }

  async function validateExistingSession() {
    const state = readState();
    if (!state.auth.token) return null;
    try {
      const res = await fetch('/api/auth/me', {
        headers: { Authorization: `Bearer ${state.auth.token}`, Accept: 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store'
      });
      if (!res.ok) throw new Error('SESSION_EXPIRED');
      return res.json();
    } catch {
      clearAuth();
      return null;
    }
  }

  async function logout() {
    const state = readState();
    try {
      if (state.auth.token) {
        await fetch('/api/auth/logout', {
          method: 'POST',
          headers: { Authorization: `Bearer ${state.auth.token}` },
          credentials: 'same-origin',
          cache: 'no-store'
        });
      }
    } catch {}
    clearAuth();
  }

  function bindPage() {
    const form = document.getElementById('authForm');
    const nameInput = document.getElementById('name');
    const passwordInput = document.getElementById('password');
    const confirmInput = document.getElementById('password2');
    const error = document.getElementById('authError');
    const submit = document.getElementById('authSubmit');
    const mode = document.body.dataset.mode;
    const isSignup = mode === 'signup';

    const showError = (message) => { error.textContent = message || ''; };

    document.getElementById('authSwitch').addEventListener('click', () => {
      location.href = isSignup ? '/Login' : '/SignUp';
    });

    const existing = readState();
    if (existing.auth.token) {
      validateExistingSession().then(session => {
        if (session) {
          writeAuth(existing.auth.token, session.profile);
          redirectHome();
        }
      });
    }

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      showError('');
      submit.disabled = true;
      submit.textContent = isSignup ? 'กำลังสมัครสมาชิก…' : 'กำลังเข้าสู่ระบบ…';
      try {
        const username = nameInput.value.trim();
        const password = passwordInput.value;
        if (!/^[A-Za-z0-9ก-๙_]{3,16}$/u.test(username)) throw new Error('ชื่อผู้ใช้ต้องยาว 3–16 ตัว และใช้ตัวอักษร/ตัวเลข/_ เท่านั้น');
        if (password.length < 6) throw new Error('รหัสผ่านต้องมีอย่างน้อย 6 ตัว');
        const payload = { name: username, password };
        if (isSignup && password !== confirmInput.value) throw new Error('รหัสผ่านยืนยันไม่ตรงกัน');
        const result = await request(isSignup ? '/api/auth/register' : '/api/auth/login', payload);
        writeAuth(result.token, result.profile);
        redirectHome();
      } catch (err) {
        showError(err?.message || 'ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้');
      } finally {
        submit.disabled = false;
        submit.textContent = isSignup ? 'สมัครสมาชิก' : 'เข้าสู่ระบบ';
      }
    });

    nameInput.focus();
  }

  function boot() {
    document.getElementById('goHome').addEventListener('click', () => { location.href = '/'; });
    bindPage();
  }

  window.XOAuthPage = { readState, writeAuth, clearAuth, validateExistingSession, logout };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
