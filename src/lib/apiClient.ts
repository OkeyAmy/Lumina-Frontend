"use client";

const TOKEN_KEY = "lumina:auth:token";

export async function revokeAuthToken(): Promise<void> {
  const token = getStoredToken();
  if (!token) return;
  try {
    await fetch("/api/auth/revoke", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
    });
  } catch {
    // Best-effort revocation; token will expire naturally
  } finally {
    clearStoredToken();
  }
}

export function getStoredToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setStoredToken(token: string | null): void {
  try {
    if (token) {
      sessionStorage.setItem(TOKEN_KEY, token);
    } else {
      sessionStorage.removeItem(TOKEN_KEY);
    }
  } catch {
    // Storage unavailable
  }
}

function clearStoredToken(): void {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage unavailable
  }
}

export function clearAuthSession(): void {
  try {
    sessionStorage.clear();
  } catch {
    // Storage unavailable
  }
}
