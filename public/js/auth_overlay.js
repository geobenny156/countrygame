// Auth overlay: shows "My Account" when signed in, or a "Sign In / Sign Up" modal otherwise.
// Works on any page that includes a container with id="accountActions".
(function () {
  function qs(id) { return document.getElementById(id); }
  function el(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }

  // Inject minimal CSS just for the modal (scoped class names)
  (function injectCss(){
    const css = `
    .auth-overlay{ position:fixed; inset:0; background:rgba(0,0,0,.6); display:none; z-index:2000; }
    .auth-overlay.open{ display:block; }
    .auth-modal{ max-width:520px; margin:10vh auto; background:var(--panel); color:var(--text);
                 border:1px solid var(--border); border-radius:12px; padding:16px; }
    .auth-modal h3{ margin:0 0 8px 0; }
    .auth-tabs{ display:flex; gap:8px; margin-top:6px; }
    .auth-tabs button{ cursor:pointer; }
    .auth-pane{ display:none; margin-top:10px; }
    .auth-pane.active{ display:block; }
    .auth-msg{ min-height:18px; margin-top:6px; }
    .auth-row{ display:flex; gap:8px; margin-top:10px; flex-wrap:wrap; }
    .auth-right{ margin-left:auto; }
    `;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  })();

  async function fetchMe() {
    try { const r = await fetch('/api/auth/me'); const j = await r.json(); return j.user || null; }
    catch { return null; }
  }
  async function validateName(name) {
    try {
      const r = await fetch('/api/name/validate', {
        method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name })
      });
      const j = await r.json(); return !!(j && j.valid);
    } catch { return false; }
  }

  function mountOverlay() {
    // Build once and reuse
    if (qs('authOverlay')) return;

    const ov = el('div', 'auth-overlay'); ov.id = 'authOverlay';
    const box = el('div', 'auth-modal');

    box.innerHTML = `
      <h3>Sign in / Sign up</h3>
      <div class="auth-tabs">
        <button id="authTabIn"  class="secondary">Sign in</button>
        <button id="authTabUp"  class="secondary">Sign up</button>
        <button id="authClose"  class="secondary auth-right">Close</button>
      </div>

      <div id="authPaneIn" class="auth-pane">
        <label style="margin-top:6px;">Email</label>
        <input id="authInEmail" type="email" placeholder="you@example.com" />
        <label style="margin-top:6px;">Password</label>
        <input id="authInPass"  type="password" placeholder="••••••••" />
        <div class="auth-row">
          <button id="authBtnIn" class="primary">Sign in</button>
          <span id="authMsgIn" class="auth-msg"></span>
        </div>
      </div>

      <div id="authPaneUp" class="auth-pane">
        <label style="margin-top:6px;">Display name</label>
        <input id="authUpName" type="text" maxlength="24" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"/>
        <label style="margin-top:6px;">Email</label>
        <input id="authUpEmail" type="email" placeholder="you@example.com" />
        <label style="margin-top:6px;">Password <small>(min 6)</small></label>
        <input id="authUpPass"  type="password" placeholder="••••••••" />
        <div class="auth-row">
          <button id="authBtnUp" class="primary">Create account</button>
          <span id="authMsgUp" class="auth-msg"></span>
        </div>
      </div>
    `;
    ov.appendChild(box);
    document.body.appendChild(ov);

    // Wire up tabs/close
    const tabIn = qs('authTabIn'), tabUp = qs('authTabUp'), close = qs('authClose');
    const paneIn = qs('authPaneIn'), paneUp = qs('authPaneUp');

    function show(which) {
      paneIn.classList.toggle('active', which === 'in');
      paneUp.classList.toggle('active', which === 'up');
    }
    tabIn.addEventListener('click', () => show('in'));
    tabUp.addEventListener('click', () => show('up'));
    close.addEventListener('click', () => ov.classList.remove('open'));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') ov.classList.remove('open'); });
    show('in');

    // Sign in
    const inEmail = qs('authInEmail'), inPass = qs('authInPass');
    const btnIn   = qs('authBtnIn'),  msgIn  = qs('authMsgIn');

    btnIn.addEventListener('click', async () => {
      msgIn.textContent = '';
      const email = (inEmail.value || '').trim().toLowerCase();
      const pass  = (inPass.value  || '');
      if (!email || !pass) { msgIn.textContent = 'Enter email and password.'; return; }
      btnIn.disabled = true; btnIn.textContent = 'Signing in…';
      try {
        const r = await fetch('/api/auth/login', {
          method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ email, password: pass })
        });
        const j = await r.json();
        if (!j || !j.ok) throw new Error(j && j.error || 'Could not sign in.');
        // Reflect in UI
        try { if (window.NG) NG.setName(j.user.displayName); } catch {}
        switchToAccountButton();
        ov.classList.remove('open');
      } catch (e) {
        msgIn.textContent = e.message || 'Could not sign in.';
      } finally {
        btnIn.disabled = false; btnIn.textContent = 'Sign in';
      }
    });

    // Sign up
    const upName = qs('authUpName'), upEmail = qs('authUpEmail'), upPass = qs('authUpPass');
    const btnUp  = qs('authBtnUp'),  msgUp   = qs('authMsgUp');

    btnUp.addEventListener('click', async () => {
      msgUp.textContent = '';
      const name  = (upName.value  || '').trim();
      const email = (upEmail.value || '').trim().toLowerCase();
      const pass  = (upPass.value  || '');
      if (!name || !email || !pass) { msgUp.textContent = 'Fill all fields.'; return; }
      btnUp.disabled = true; btnUp.textContent = 'Creating…';
      try {
        const okName = await validateName(name);
        if (!okName) throw new Error('That display name is not allowed.');

        const r = await fetch('/api/auth/signup', {
          method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ email, password: pass, displayName: name })
        });
        const j = await r.json();
        if (!j || !j.ok) throw new Error(j && j.error || 'Could not sign up.');

        try { if (window.NG) NG.setName(j.user.displayName); } catch {}
        switchToAccountButton();
        ov.classList.remove('open');
      } catch (e) {
        msgUp.textContent = e.message || 'Could not sign up.';
      } finally {
        btnUp.disabled = false; btnUp.textContent = 'Create account';
      }
    });
  }

  function switchToAccountButton() {
    const box = qs('accountActions'); if (!box) return;
    box.innerHTML = '';
    const a = el('a'); a.href = 'account_settings.html'; a.className = 'secondary'; a.textContent = 'My Account';
    box.appendChild(a);
  }

  async function init() {
    const box = qs('accountActions'); if (!box) return;
    mountOverlay();
    let user = await fetchMe();

    box.innerHTML = '';
    if (user) {
      const a = el('a'); a.href = 'account_settings.html'; a.className = 'secondary'; a.textContent = 'My Account';
      box.appendChild(a);
    } else {
      const btn = el('button', 'secondary'); btn.id = 'openAuthOverlay'; btn.textContent = 'Sign In / Sign Up';
      btn.addEventListener('click', () => qs('authOverlay').classList.add('open'));
      box.appendChild(btn);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
