// 口令鉴权：GET 探测是否启用/已登录；POST 口令换 HttpOnly cookie
export interface AuthStatus {
  required: boolean;
  ok: boolean;
}

export async function authStatus(): Promise<AuthStatus> {
  try {
    const r = await fetch('/api/auth');
    if (r.ok) return (await r.json()) as AuthStatus;
  } catch {
    /* noop */
  }
  return { required: false, ok: true }; // 探测失败按无门禁处理，后续连接错误照常提示
}

export async function authLogin(token: string): Promise<boolean> {
  try {
    const r = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    return r.ok;
  } catch {
    return false;
  }
}
