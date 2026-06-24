import assert from "node:assert/strict";
import {
  SessionWatcher,
  SessionState,
  type FreighterAPI,
  type SessionWatcherEnvironment,
} from "../sessionWatcher";

interface TestFailure {
  name: string;
  reason: string;
}

const failures: TestFailure[] = [];

function assertEq<T>(name: string, expected: T, actual: T) {
  try {
    assert.deepEqual(actual, expected);
    console.log(`  ✓ ${name}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    failures.push({ name, reason: message });
    console.error(`  ✗ ${name}: ${message}`);
  }
}

function createMockFreighter(
  overrides: Partial<FreighterAPI> = {},
): FreighterAPI {
  return {
    isConnected: overrides.isConnected ?? (async () => ({ isConnected: true })),
    getUserInfo:
      overrides.getUserInfo ??
      (async () => ({ publicKey: "GALICE" })),
  };
}

function createMockEnvironment(
  overrides: Partial<SessionWatcherEnvironment> = {},
): SessionWatcherEnvironment {
  const sessionStore = new Map<string, string>();
  return {
    freighter: overrides.freighter ?? createMockFreighter(),
    location: overrides.location ?? {
      href: "https://app.lumina.network/dashboard",
      assign: () => {},
    },
    sessionStorage: overrides.sessionStorage ?? {
      getItem: (key: string) => sessionStore.get(key) ?? null,
      setItem: (key: string, value: string) => { sessionStore.set(key, value); },
      removeItem: (key: string) => { sessionStore.delete(key); },
      clear: () => { sessionStore.clear(); },
      get length() { return sessionStore.size; },
      key: (index: number) => Array.from(sessionStore.keys())[index] ?? null,
    },
    fetch: overrides.fetch ?? (async () => new Response(null, { status: 200 })),
  };
}

async function run() {
  console.log("sessionWatcher: constructs and starts in ACTIVE state");

  // Test 1: Default state is ACTIVE
  {
    const freighter = createMockFreighter();
    const env = createMockEnvironment({ freighter });
    const watcher = new SessionWatcher({
      pollIntervalMs: 50,
      env,
    });

    watcher.start("GALICE");
    assertEq("initial state is ACTIVE", SessionState.ACTIVE, watcher.getState());
    watcher.stop();
  }

  // Test 2: Detects wallet disconnect via isConnected() returning false
  {
    const freighter = createMockFreighter({
      isConnected: async () => ({ isConnected: false }),
    });
    let assignedUrl = "";
    const env = createMockEnvironment({
      freighter,
      location: {
        href: "https://app.lumina.network/dashboard",
        assign: (url: string) => { assignedUrl = url; },
      },
    });

    const watcher = new SessionWatcher({
      pollIntervalMs: 50,
      env,
    });

    watcher.start("GALICE");
    await new Promise((r) => setTimeout(r, 150));
    assertEq(
      "disconnects wallet when isConnected=false",
      SessionState.WALLET_DISCONNECTED,
      watcher.getState(),
    );
    assertEq(
      "redirects to /login with session expired",
      true,
      assignedUrl.startsWith("/login?"),
    );
    assertEq(
      "includes session=expired param",
      true,
      assignedUrl.includes("session=expired"),
    );
    watcher.stop();
  }

  // Test 3: Detects wallet lock via getUserInfo() throwing
  {
    const freighter = createMockFreighter({
      isConnected: async () => ({ isConnected: true }),
      getUserInfo: async () => { throw new Error("Wallet locked"); },
    });
    let assignedUrl = "";
    const env = createMockEnvironment({
      freighter,
      location: {
        href: "https://app.lumina.network/dashboard",
        assign: (url: string) => { assignedUrl = url; },
      },
    });

    const watcher = new SessionWatcher({
      pollIntervalMs: 50,
      env,
    });

    watcher.start("GALICE");
    await new Promise((r) => setTimeout(r, 150));
    assertEq(
      "detects wallet lock via getUserInfo throw",
      SessionState.WALLET_DISCONNECTED,
      watcher.getState(),
    );
    assertEq(
      "redirects to /login",
      true,
      assignedUrl.startsWith("/login?"),
    );
    watcher.stop();
  }

  // Test 4: Does NOT trigger on account switch (different publicKey)
  {
    let callCount = 0;
    const freighter = createMockFreighter({
      isConnected: async () => ({ isConnected: true }),
      getUserInfo: async () => {
        callCount++;
        return { publicKey: "GBOB" };
      },
    });

    const watcher = new SessionWatcher({
      pollIntervalMs: 50,
      env: createMockEnvironment({ freighter }),
    });

    watcher.start("GALICE");
    await new Promise((r) => setTimeout(r, 150));
    // Should not disconnect because detected key differs from currentPublicKey
    assertEq(
      "stays ACTIVE on account switch",
      SessionState.ACTIVE,
      watcher.getState(),
    );
    watcher.stop();
  }

  // Test 5: updatePublicKey with null stops polling
  {
    const freighter = createMockFreighter();
    const env = createMockEnvironment({ freighter });
    const watcher = new SessionWatcher({
      pollIntervalMs: 50,
      env,
    });

    watcher.start("GALICE");
    watcher.updatePublicKey(null);
    // Polling should stop - force a fake disconnect to verify it's not detected
    freighter.isConnected = async () => ({ isConnected: false });
    await new Promise((r) => setTimeout(r, 150));
    assertEq(
      "stays ACTIVE after publicKey set to null",
      SessionState.ACTIVE,
      watcher.getState(),
    );
    watcher.stop();
  }

  // Test 6: Logout clears sessionStorage and revokes auth token
  {
    let revoked = false;
    const mockFetch = async (url: string, init?: RequestInit) => {
      if (url === "/api/auth/revoke") {
        revoked = true;
      }
      return new Response(null, { status: 200 });
    };

    const freighter = createMockFreighter({
      isConnected: async () => ({ isConnected: false }),
    });
    const sessionStore = new Map<string, string>();
    sessionStore.set("lumina:auth:token", "test-jwt");
    const env = createMockEnvironment({
      freighter,
      fetch: mockFetch as unknown as typeof fetch,
      sessionStorage: {
        getItem: (key: string) => sessionStore.get(key) ?? null,
        setItem: (key: string, value: string) => { sessionStore.set(key, value); },
        removeItem: (key: string) => { sessionStore.delete(key); },
        clear: () => { sessionStore.clear(); },
        get length() { return sessionStore.size; },
        key: (index: number) => Array.from(sessionStore.keys())[index] ?? null,
      },
    });

    const watcher = new SessionWatcher({
      pollIntervalMs: 50,
      env,
    });

    watcher.start("GALICE");
    await new Promise((r) => setTimeout(r, 150));
    assertEq(
      "detected disconnect",
      SessionState.WALLET_DISCONNECTED,
      watcher.getState(),
    );
    assertEq("clears sessionStorage", 0, sessionStore.size);
    assertEq("revokes auth token", true, revoked);
    watcher.stop();
  }

  // Test 7: Idle timeout triggers IDLE_LOCKED
  {
    const freighter = createMockFreighter();
    let assignedUrl = "";
    const env = createMockEnvironment({
      freighter,
      location: {
        href: "https://app.lumina.network/dashboard",
        assign: (url: string) => { assignedUrl = url; },
      },
    });
    const idleTimeoutMs = 100;

    const watcher = new SessionWatcher({
      pollIntervalMs: 500,
      idleTimeoutMs,
      env,
    });

    watcher.start("GALICE");
    await new Promise((r) => setTimeout(r, idleTimeoutMs + 200));
    assertEq(
      "idle timeout triggers IDLE_LOCKED",
      SessionState.IDLE_LOCKED,
      watcher.getState(),
    );
    assertEq(
      "redirects on idle",
      true,
      assignedUrl.startsWith("/login?"),
    );
    watcher.stop();
  }

  // Test 8: Transaction boundary - logout completes within 1 second SLA
  {
    const freighter = createMockFreighter({
      isConnected: async () => ({ isConnected: false }),
    });
    let revokeCalledAt = 0;
    let redirectCalledAt = 0;
    const mockFetch = async (url: string) => {
      if (url === "/api/auth/revoke") {
        revokeCalledAt = Date.now();
      }
      return new Response(null, { status: 200 });
    };

    const env = createMockEnvironment({
      freighter,
      fetch: mockFetch as unknown as typeof fetch,
      location: {
        href: "https://app.lumina.network/dashboard",
        assign: (url: string) => {
          redirectCalledAt = Date.now();
        },
      },
    });

    const watcher = new SessionWatcher({
      pollIntervalMs: 50,
      env,
    });

    const startTime = Date.now();
    watcher.start("GALICE");
    await new Promise((r) => setTimeout(r, 300));
    const elapsed = Math.max(redirectCalledAt, revokeCalledAt) - startTime;

    assertEq(
      "session state is WALLET_DISCONNECTED",
      SessionState.WALLET_DISCONNECTED,
      watcher.getState(),
    );
    assertEq(
      "redirect was called",
      true,
      redirectCalledAt > 0,
    );
    assertEq(
      `logout completes within 1s SLA (elapsed: ${elapsed}ms)`,
      true,
      elapsed < 1000,
    );
    watcher.stop();
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} test failure(s):`);
    for (const f of failures) {
      console.error(` - ${f.name}: ${f.reason}`);
    }
    process.exit(1);
  }
  console.log("\nAll sessionWatcher integration tests passed.");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

export {};
