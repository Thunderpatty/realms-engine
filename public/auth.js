const authMessage = document.getElementById('authMessage');
const loginForm = document.getElementById('loginForm');
const registerForm = document.getElementById('registerForm');
const resetPasswordForm = document.getElementById('resetPasswordForm');

function showMessage(text, type = 'info') {
  authMessage.textContent = text;
  authMessage.className = `message ${type}`;
}

function hideMessage() {
  authMessage.className = 'message hidden';
  authMessage.textContent = '';
}

async function submitLogin(form) {
  const formData = new FormData(form);
  const payload = Object.fromEntries(formData.entries());

  showMessage('Opening the realm gate…', 'info');

  const response = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  if (!response.ok) {
    showMessage(data.error || 'Login failed.', 'error');
    return;
  }

  showMessage('Welcome back, adventurer. Entering realm…', 'info');
  window.location.href = data.redirect || '/fantasy-rpg';
}

async function submitRegistration(form) {
  const formData = new FormData(form);
  const payload = Object.fromEntries(formData.entries());

  showMessage('Forging your adventurer record…', 'info');

  const response = await fetch('/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  if (!response.ok) {
    showMessage(data.error || 'Registration failed.', 'error');
    return;
  }

  showMessage('Adventurer created. Entering realm…', 'info');
  window.location.href = data.redirect || '/fantasy-rpg';
}

async function submitPasswordReset(form) {
  const formData = new FormData(form);
  const payload = Object.fromEntries(formData.entries());

  showMessage('Resetting password…', 'info');

  const response = await fetch('/api/reset-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  if (!response.ok) {
    showMessage(data.error || 'Password reset failed.', 'error');
    return;
  }

  showMessage('Password reset. Entering realm…', 'info');
  window.location.href = data.redirect || '/fantasy-rpg';
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  await submitLogin(loginForm);
});

registerForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  await submitRegistration(registerForm);
});

resetPasswordForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  await submitPasswordReset(resetPasswordForm);
});

fetch('/api/me')
  .then((response) => response.json())
  .then((data) => {
    if (data.authenticated) {
      window.location.href = '/fantasy-rpg';
    } else {
      hideMessage();
    }
  })
  .catch(() => {});
