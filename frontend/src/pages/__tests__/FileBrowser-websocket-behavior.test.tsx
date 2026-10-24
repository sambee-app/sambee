import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { NavigateFunction } from "react-router-dom";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UseCompanionResult } from "../../hooks/useCompanion";
import { LocalePreferencesProvider } from "../../i18n/LocalePreferencesProvider";
import api from "../../services/api";
import { authSession } from "../../services/authSession";
import { getBackendAvailabilitySnapshot, resetBackendAvailabilityForTests } from "../../services/backendAvailability";
import { logger } from "../../services/logger";
import { createMockAuthToken } from "../../test/fixtures/users";
import { type ApiMock, setupSuccessfulApiMocks } from "../../test/helpers";
import { requireTestValue } from "../../test/helpers/assertions";
import { SambeeThemeProvider } from "../../theme/ThemeContext";
import FileBrowser from "../FileBrowser";

const mockUseCompanion = vi.fn<() => UseCompanionResult>();
const mockBuildCompanionWsUrl = vi.fn<() => Promise<string | null>>();
const mockCopyMoveDialog = vi.fn();

vi.mock("../../services/api");
vi.mock("../../components/FileBrowser/CopyMoveDialog", () => ({
  default: (props: unknown) => {
    mockCopyMoveDialog(props);
    return null;
  },
}));
vi.mock("../../hooks/useCompanion", () => ({
  useCompanion: () => mockUseCompanion(),
}));
vi.mock("../../services/companion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/companion")>();
  return {
    ...actual,
    buildCompanionWsUrl: () => mockBuildCompanionWsUrl(),
  };
});

class InspectableWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: InspectableWebSocket[] = [];

  url: string;
  readyState = InspectableWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  sentMessages: string[] = [];

  constructor(url: string) {
    this.url = url;
    InspectableWebSocket.instances.push(this);
  }

  close() {
    this.readyState = InspectableWebSocket.CLOSED;
    this.onclose?.(new CloseEvent("close"));
  }

  open() {
    this.readyState = InspectableWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  send(data: string) {
    this.sentMessages.push(data);
  }
  addEventListener() {}
  removeEventListener() {}
}

const parseSentMessages = (socket: InspectableWebSocket | undefined) =>
  socket ? socket.sentMessages.map((message) => JSON.parse(message) as { action: string; connection_id: string; path: string }) : [];

const isServerSocket = (socket: InspectableWebSocket) => socket.url.includes("token=fake-token");
const isCompanionSocket = (socket: InspectableWebSocket) => socket.url.includes("21549");

function renderBrowserWithNavigator(initialPath: string) {
  let navigateFn: NavigateFunction | null = null;

  const NavigationCapture = () => {
    navigateFn = useNavigate();
    return null;
  };

  const renderResult = render(
    <LocalePreferencesProvider>
      <SambeeThemeProvider>
        <MemoryRouter initialEntries={[initialPath]}>
          <NavigationCapture />
          <Routes>
            <Route path="/browse/:targetType/:targetId/*" element={<FileBrowser />} />
            <Route path="/browse" element={<FileBrowser />} />
            <Route path="/login" element={<div>Login Page</div>} />
          </Routes>
        </MemoryRouter>
      </SambeeThemeProvider>
    </LocalePreferencesProvider>
  );

  return {
    ...renderResult,
    navigate: (path: string) => {
      if (!navigateFn) {
        throw new Error("navigate function was not initialized");
      }

      const navigate = navigateFn;
      act(() => {
        navigate(path);
      });
    },
  };
}

const buildDefaultCompanionResult = (): UseCompanionResult => ({
  status: "unavailable",
  drives: [],
  initiatePairing: vi.fn(),
  confirmPairing: vi.fn(),
  refresh: vi.fn(),
  loading: false,
});

describe("FileBrowser WebSocket behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetBackendAvailabilityForTests();
    authSession.setAuthenticated(createMockAuthToken({ access_token: "fake-token", token_type: "bearer" }), false);
    InspectableWebSocket.instances = [];
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: InspectableWebSocket,
    });

    mockUseCompanion.mockReturnValue(buildDefaultCompanionResult());
    mockBuildCompanionWsUrl.mockResolvedValue("ws://localhost:21549/api/ws?hmac=test&ts=1&origin=http%3A%2F%2Flocalhost%3A3000");

    setupSuccessfulApiMocks(api as unknown as ApiMock);
  });

  it("redacts the server WebSocket token from connection logs", async () => {
    const infoSpy = vi.spyOn(logger, "info");
    const { renderBrowser } = await import("./FileBrowser.test.utils");

    renderBrowser("/browse/smb/test-server-1");

    await waitFor(() => {
      expect(infoSpy).toHaveBeenCalledWith(
        "Connecting to WebSocket",
        { wsUrl: "ws://localhost:3000/api/ws", reason: "initial" },
        "websocket"
      );
    });

    expect(infoSpy.mock.calls.some(([, context]) => JSON.stringify(context).includes("fake-token"))).toBe(false);
  });

  it("redacts the companion WebSocket signature from connection logs", async () => {
    mockUseCompanion.mockReturnValue({
      ...buildDefaultCompanionResult(),
      status: "paired",
    });
    const infoSpy = vi.spyOn(logger, "info");
    const { renderBrowser } = await import("./FileBrowser.test.utils");

    renderBrowser("/browse/local/c/Users");

    await waitFor(() => {
      expect(infoSpy).toHaveBeenCalledWith("Connecting to companion WebSocket", { wsUrl: "ws://localhost:21549/api/ws" }, "websocket");
    });

    expect(infoSpy.mock.calls.some(([, context]) => JSON.stringify(context).includes("hmac=test"))).toBe(false);
  });

  it("does not mark the backend as reconnecting when the realtime socket closes", async () => {
    const { renderBrowser } = await import("./FileBrowser.test.utils");

    renderBrowser("/browse/smb/test-server-1");

    await waitFor(() => {
      expect(InspectableWebSocket.instances.length).toBeGreaterThan(0);
    });

    const backendSocket = InspectableWebSocket.instances.find(isServerSocket);
    expect(backendSocket?.url).toBe("ws://localhost:3000/api/ws?token=fake-token");

    backendSocket?.close();

    expect(getBackendAvailabilitySnapshot().status).toBe("available");
  });

  it("ignores malformed WebSocket frames and continues handling later directory changes", async () => {
    const warnSpy = vi.spyOn(logger, "warn");
    const { renderBrowser } = await import("./FileBrowser.test.utils");

    renderBrowser("/browse/smb/test-server-1");

    await waitFor(() => {
      expect(InspectableWebSocket.instances.length).toBeGreaterThan(0);
      expect(api.listDirectory).toHaveBeenCalledTimes(1);
    });
    const backendSocket = InspectableWebSocket.instances.find(isServerSocket);
    expect(backendSocket).toBeDefined();
    backendSocket?.open();

    expect(() => {
      act(() => {
        backendSocket?.onmessage?.(new MessageEvent("message", { data: "not-json" }));
      });
    }).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith("Ignoring malformed WebSocket message", undefined, "websocket");

    act(() => {
      backendSocket?.onmessage?.(
        new MessageEvent("message", { data: JSON.stringify({ type: "directory_changed", connection_id: "conn-1", path: "" }) })
      );
    });

    await waitFor(() => {
      expect(api.listDirectory).toHaveBeenCalledTimes(2);
    });
  });

  it("coalesces directory notifications during an upload into one final listing refresh", async () => {
    let finishUpload:
      | ((result: { status: "completed"; replaced: false; effects: { source: "unchanged"; destination: "mutated" } }) => void)
      | undefined;
    vi.mocked(api.publishBrowserFile).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishUpload = resolve;
        })
    );
    const pickerClick = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) {
      if (this.type !== "file") return;
      Object.defineProperty(this, "files", { value: [new File(["data"], "new.txt")] });
      this.dispatchEvent(new Event("change", { bubbles: true }));
    });
    try {
      const { renderBrowser } = await import("./FileBrowser.test.utils");
      renderBrowser("/browse/smb/test-server-1");
      await waitFor(() => expect(api.listDirectory).toHaveBeenCalledTimes(1));
      const backendSocket = InspectableWebSocket.instances.find(isServerSocket);
      backendSocket?.open();
      fireEvent.click(screen.getByRole("button", { name: "Upload" }));
      fireEvent.click(await screen.findByRole("menuitem", { name: "Files" }));
      await waitFor(() => expect(finishUpload).toBeDefined());

      act(() => {
        for (let index = 0; index < 2; index++) {
          backendSocket?.onmessage?.(
            new MessageEvent("message", { data: JSON.stringify({ type: "directory_changed", connection_id: "conn-1", path: "" }) })
          );
        }
      });
      expect(api.listDirectory).toHaveBeenCalledTimes(1);

      act(() => finishUpload!({ status: "completed", replaced: false, effects: { source: "unchanged", destination: "mutated" } }));
      await waitFor(() => expect(api.listDirectory).toHaveBeenCalledTimes(2));
      act(() => {
        backendSocket?.onmessage?.(
          new MessageEvent("message", { data: JSON.stringify({ type: "directory_changed", connection_id: "conn-1", path: "" }) })
        );
      });
      expect(api.listDirectory).toHaveBeenCalledTimes(2);
    } finally {
      pickerClick.mockRestore();
    }
  });

  it("refreshes a deferred directory change when an upload is cancelled", async () => {
    vi.mocked(api.publishBrowserFile).mockImplementation(
      (_file, _connectionId, _path, _policy, options) =>
        new Promise((resolve) => {
          requireTestValue(options).signal?.addEventListener(
            "abort",
            () => resolve({ status: "cancelled", replaced: false, effects: { source: "unchanged", destination: "unchanged" } }),
            { once: true }
          );
        })
    );
    const pickerClick = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) {
      if (this.type !== "file") return;
      Object.defineProperty(this, "files", { value: [new File(["data"], "new.txt")] });
      this.dispatchEvent(new Event("change", { bubbles: true }));
    });
    try {
      const { renderBrowser } = await import("./FileBrowser.test.utils");
      renderBrowser("/browse/smb/test-server-1");
      await waitFor(() => expect(api.listDirectory).toHaveBeenCalledTimes(1));
      const backendSocket = InspectableWebSocket.instances.find(isServerSocket);
      backendSocket?.open();
      fireEvent.click(screen.getByRole("button", { name: "Upload" }));
      fireEvent.click(await screen.findByRole("menuitem", { name: "Files" }));
      await waitFor(() => expect(api.publishBrowserFile).toHaveBeenCalledOnce());

      act(() => {
        backendSocket?.onmessage?.(
          new MessageEvent("message", { data: JSON.stringify({ type: "directory_changed", connection_id: "conn-1", path: "" }) })
        );
      });
      expect(api.listDirectory).toHaveBeenCalledTimes(1);
      fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(api.listDirectory).toHaveBeenCalledTimes(2));
    } finally {
      pickerClick.mockRestore();
    }
  });

  it("ignores acknowledged WebSocket control frames without malformed-message warnings", async () => {
    const warnSpy = vi.spyOn(logger, "warn");
    const { renderBrowser } = await import("./FileBrowser.test.utils");

    renderBrowser("/browse/smb/test-server-1");

    await waitFor(() => {
      expect(InspectableWebSocket.instances.length).toBeGreaterThan(0);
    });
    const backendSocket = InspectableWebSocket.instances.find(isServerSocket);
    expect(backendSocket).toBeDefined();
    backendSocket?.open();
    warnSpy.mockClear();
    mockCopyMoveDialog.mockClear();

    act(() => {
      for (const type of ["subscribed", "unsubscribed", "pong"]) {
        backendSocket?.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ type }) }));
      }
    });

    expect(warnSpy).not.toHaveBeenCalledWith("Ignoring malformed WebSocket message", undefined, "websocket");
    expect(mockCopyMoveDialog).not.toHaveBeenCalled();
  });

  it("does not build a companion WebSocket while viewing only SMB panes", async () => {
    mockUseCompanion.mockReturnValue({
      ...buildDefaultCompanionResult(),
      status: "paired",
    });

    const { renderBrowser } = await import("./FileBrowser.test.utils");

    renderBrowser("/browse/smb/test-server-1");

    await waitFor(() => {
      expect(api.listDirectory).toHaveBeenCalled();
    });

    expect(mockBuildCompanionWsUrl).not.toHaveBeenCalled();
    expect(InspectableWebSocket.instances.every((socket) => !socket.url.includes("21549"))).toBe(true);
  });

  it("builds a companion WebSocket after a visible local-drive pane becomes active", async () => {
    mockUseCompanion.mockReturnValue({
      ...buildDefaultCompanionResult(),
      status: "paired",
    });

    const { renderBrowser } = await import("./FileBrowser.test.utils");

    renderBrowser("/browse/local/c/Users");

    await waitFor(() => {
      expect(mockBuildCompanionWsUrl).toHaveBeenCalled();
    });

    expect(InspectableWebSocket.instances.some((socket) => socket.url.includes("21549"))).toBe(true);
  });

  it("re-subscribes only on the reconnecting transport", async () => {
    mockUseCompanion.mockReturnValue({
      ...buildDefaultCompanionResult(),
      status: "paired",
      drives: [
        {
          id: "local-drive:c",
          name: "Drive C",
          drive_type: "fixed",
        },
      ],
    });

    const { renderBrowser } = await import("./FileBrowser.test.utils");

    renderBrowser("/browse/smb/test-server-1/Documents?p2=local/c/Users");

    await waitFor(() => {
      expect(InspectableWebSocket.instances.length).toBeGreaterThanOrEqual(2);
    });

    const backendSocket = InspectableWebSocket.instances.find(isServerSocket);
    const companionSocket = InspectableWebSocket.instances.find(isCompanionSocket);

    expect(backendSocket).toBeDefined();
    expect(companionSocket).toBeDefined();

    backendSocket?.open();
    companionSocket?.open();

    await waitFor(() => {
      expect(parseSentMessages(backendSocket)).toContainEqual({
        action: "subscribe",
        connection_id: "conn-1",
        path: "Documents",
      });
      expect(parseSentMessages(companionSocket)).toContainEqual({
        action: "subscribe",
        connection_id: "local-drive:c",
        path: "Users",
      });
    });

    const companionMessageCountBeforeReconnect = companionSocket?.sentMessages.length ?? 0;

    backendSocket?.close();

    await waitFor(() => {
      expect(InspectableWebSocket.instances.filter(isServerSocket).length).toBeGreaterThanOrEqual(2);
    });

    const replacementBackendSocket = [...InspectableWebSocket.instances]
      .reverse()
      .find((socket) => isServerSocket(socket) && socket !== backendSocket);

    expect(replacementBackendSocket).toBeDefined();

    replacementBackendSocket?.open();

    await waitFor(() => {
      expect(parseSentMessages(replacementBackendSocket)).toContainEqual({
        action: "subscribe",
        connection_id: "conn-1",
        path: "Documents",
      });
    });

    expect(companionSocket?.sentMessages.length).toBe(companionMessageCountBeforeReconnect);
  });

  it("deduplicates same-directory subscriptions across dual SMB panes", async () => {
    const { renderBrowser } = await import("./FileBrowser.test.utils");

    renderBrowser("/browse/smb/test-server-1/Documents?p2=smb/test-server-1/Documents");

    await waitFor(() => {
      expect(InspectableWebSocket.instances.length).toBeGreaterThan(0);
    });

    const backendSocket = InspectableWebSocket.instances.find(isServerSocket);
    expect(backendSocket).toBeDefined();

    backendSocket?.open();

    await waitFor(() => {
      const subscribeMessages = parseSentMessages(backendSocket).filter((message) => message.action === "subscribe");
      expect(subscribeMessages).toEqual([
        {
          action: "subscribe",
          connection_id: "conn-1",
          path: "Documents",
        },
      ]);
    });
  });

  it("does not churn the unchanged SMB sibling path when one dual-pane path changes", async () => {
    const { navigate } = renderBrowserWithNavigator("/browse/smb/test-server-1/Documents?p2=smb/test-server-1/Pictures");

    await waitFor(() => {
      expect(InspectableWebSocket.instances.length).toBeGreaterThan(0);
    });

    const backendSocket = InspectableWebSocket.instances.find(isServerSocket);
    expect(backendSocket).toBeDefined();

    backendSocket?.open();

    await waitFor(() => {
      expect(parseSentMessages(backendSocket)).toContainEqual({
        action: "subscribe",
        connection_id: "conn-1",
        path: "Documents",
      });
      expect(parseSentMessages(backendSocket)).toContainEqual({
        action: "subscribe",
        connection_id: "conn-1",
        path: "Pictures",
      });
    });

    const previousMessageCount = backendSocket?.sentMessages.length ?? 0;

    navigate("/browse/smb/test-server-1?p2=smb/test-server-1/Pictures");

    await waitFor(() => {
      const delta = parseSentMessages(backendSocket).slice(previousMessageCount);
      expect(delta).toEqual([
        {
          action: "unsubscribe",
          connection_id: "conn-1",
          path: "Documents",
        },
        {
          action: "subscribe",
          connection_id: "conn-1",
          path: "",
        },
      ]);
    });
  });

  it("does not churn the unchanged local-drive sibling path when one dual-pane path changes", async () => {
    mockUseCompanion.mockReturnValue({
      ...buildDefaultCompanionResult(),
      status: "paired",
      drives: [
        {
          id: "local-drive:c",
          name: "Drive C",
          drive_type: "fixed",
        },
      ],
    });

    const { navigate } = renderBrowserWithNavigator("/browse/local/c/Users?p2=local/c/Documents");

    await waitFor(() => {
      expect(InspectableWebSocket.instances.some(isCompanionSocket)).toBe(true);
    });

    const companionSocket = InspectableWebSocket.instances.find(isCompanionSocket);
    expect(companionSocket).toBeDefined();

    companionSocket?.open();

    await waitFor(() => {
      expect(parseSentMessages(companionSocket)).toContainEqual({
        action: "subscribe",
        connection_id: "local-drive:c",
        path: "Users",
      });
      expect(parseSentMessages(companionSocket)).toContainEqual({
        action: "subscribe",
        connection_id: "local-drive:c",
        path: "Documents",
      });
    });

    const previousMessageCount = companionSocket?.sentMessages.length ?? 0;

    navigate("/browse/local/c?p2=local/c/Documents");

    await waitFor(() => {
      const delta = parseSentMessages(companionSocket).slice(previousMessageCount);
      expect(delta).toEqual([
        {
          action: "unsubscribe",
          connection_id: "local-drive:c",
          path: "Users",
        },
        {
          action: "subscribe",
          connection_id: "local-drive:c",
          path: "",
        },
      ]);
    });
  });
});
