import { Capacitor, registerPlugin } from '@capacitor/core';

const sessionPlugin = registerPlugin('SessionStore');
const native = () => Capacitor.isNativePlatform();

/** Load a previously encrypted native session, if the Keystore is available. */
export async function loadPersistedSession() {
  if (!native()) return null;
  try {
    const result = await sessionPlugin.load();
    const session = result?.session;
    if (!session || typeof session.token !== 'string' || !Number.isFinite(session.expiresAt)) return null;
    if (session.expiresAt <= Date.now()) {
      await sessionPlugin.clear().catch(() => {});
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

/** Persist the in-memory token through the native Keystore; never browser storage. */
export async function persistSession(session) {
  if (!native()) return;
  try { await sessionPlugin.save(session); } catch { /* login still works for this process */ }
}

export async function clearPersistedSession() {
  if (!native()) return;
  try { await sessionPlugin.clear(); } catch { /* ignore */ }
}
