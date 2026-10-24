import "@testing-library/jest-dom";
import * as events from "node:events";
import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, vi } from "vitest";
import { server } from "./mocks/server";

const TEST_EVENT_TARGET_MAX_LISTENERS = 0;

events.setMaxListeners(TEST_EVENT_TARGET_MAX_LISTENERS);

// React can report the document as a focus event's related target in jsdom.
// MUI restores focus to that target while unmounting overlays.
if (typeof (document as Document & { focus?: () => void }).focus !== "function") {
  Object.defineProperty(document, "focus", { configurable: true, value: () => {} });
}

const mockLocation = {
  href: "http://localhost:3000/",
  origin: "http://localhost:3000",
  protocol: "http:",
  host: "localhost:3000",
  hostname: "localhost",
  port: "3000",
  pathname: "/",
  search: "",
  hash: "",
  assign: vi.fn(),
  reload: vi.fn(),
};

// Set up fake location for jsdom/MSW - must be before MSW setup
Object.defineProperty(window, "location", {
  writable: true,
  value: mockLocation,
});

// Start MSW server before all tests
beforeAll(() => {
  server.listen({
    onUnhandledFrame({ frame, defaults }) {
      // Ignore WebSocket connection attempts - they're mocked separately
      if (frame.protocol === "ws") {
        return;
      }
      const request = frame.data && typeof frame.data === "object" && "request" in frame.data ? frame.data.request : null;
      // Ignore companion background health probes triggered by FileBrowser.
      // These requests are expected during test startup and their failures are
      // already handled by the hook as a normal "companion unavailable" path.
      if (request instanceof Request && (request.url.includes("/api/ws") || request.url === "http://localhost:21549/api/health")) {
        return;
      }
      // Warn about other unhandled requests
      defaults.warn();
    },
  });
});

// Reset handlers and cleanup after each test
afterEach(() => {
  server.resetHandlers();
  cleanup();
  window.sessionStorage?.clear();
});

// Stop MSW server after all tests
afterAll(() => {
  server.close();
});

// Mock window.matchMedia
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// Mock ResizeObserver
class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

global.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;

// Mock WebSocket - Prevent actual connections and reconnect delays in tests
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  url: string;
  readyState: number = MockWebSocket.CLOSED; // Start as CLOSED to prevent connection attempts
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    // DO NOT simulate connection - just stay closed to avoid console spam and delays
    // Tests that need WebSocket behavior can override this mock
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    if (this.onclose) {
      this.onclose(new CloseEvent("close"));
    }
  }

  send(_data: string) {
    // No-op in tests, but doesn't throw
  }

  addEventListener() {}
  removeEventListener() {}
}

global.WebSocket = MockWebSocket as unknown as typeof WebSocket;

// Mock localStorage with a proper in-memory implementation
const localStorageMock = (() => {
  let store: Record<string, string> = {};

  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => {
      store[key] = value.toString();
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
  };
})();

Object.defineProperty(window, "localStorage", {
  value: localStorageMock,
});

if (typeof Reflect.get(globalThis, "Iterator") === "undefined") {
  class IteratorHelperPolyfill<TValue> {
    private readonly values: TValue[];

    constructor(iterable: Iterable<TValue>) {
      this.values = Array.from(iterable);
    }

    map<TResult>(mapper: (value: TValue, index: number) => TResult): IteratorHelperPolyfill<TResult> {
      return new IteratorHelperPolyfill(this.values.map(mapper));
    }

    toArray(): TValue[] {
      return [...this.values];
    }

    [Symbol.iterator](): Iterator<TValue> {
      return this.values[Symbol.iterator]();
    }
  }

  class IteratorPolyfill {}

  Object.defineProperty(IteratorPolyfill, "from", {
    value: <TValue>(iterable: Iterable<TValue>) => new IteratorHelperPolyfill(iterable),
    configurable: true,
    writable: true,
  });

  Object.defineProperty(globalThis, "Iterator", {
    value: IteratorPolyfill,
    configurable: true,
    writable: true,
  });
}

// Keep a stable, fully populated location object for tests that construct URLs.

if (typeof Range !== "undefined") {
  const emptyRect = {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    toJSON: () => ({}),
  } as DOMRect;

  if (!Range.prototype.getBoundingClientRect) {
    Range.prototype.getBoundingClientRect = () => emptyRect;
  }

  if (!Range.prototype.getClientRects) {
    Range.prototype.getClientRects = () =>
      ({
        length: 0,
        item: () => null,
        [Symbol.iterator]: function* iterator() {},
      }) as DOMRectList;
  }
}
