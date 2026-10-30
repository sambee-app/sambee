import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCAL_DRIVES_PAGE_COPY } from "../../components/Settings/localDrivesCopy";
import { clearCachedAsyncData } from "../../hooks/useCachedAsyncData";
import { SambeeThemeProvider } from "../../theme";
import { LocalDrivesSettings } from "../LocalDrivesSettings";

const { mockCheckHealth, mockGetPairStatus, mockGetCompanionDownloads, mockHasStoredSecret, mockTestPairing, mockUnpairCurrentOrigin } =
  vi.hoisted(() => ({
    mockCheckHealth: vi.fn(),
    mockGetPairStatus: vi.fn(),
    mockGetCompanionDownloads: vi.fn(),
    mockHasStoredSecret: vi.fn(),
    mockTestPairing: vi.fn(),
    mockUnpairCurrentOrigin: vi.fn(),
  }));

vi.mock("../../components/FileBrowser/CompanionPairingDialog", () => ({
  __esModule: true,
  default: () => null,
}));

vi.mock("../../services/logger", () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("../../services/api", () => ({
  __esModule: true,
  default: {
    getThemes: () => Promise.resolve({ themes: [], site_default_id: "sambee-light" }),
    getCurrentUser: () => Promise.resolve({ role: "editor" }),
    getCompanionDownloads: mockGetCompanionDownloads,
  },
}));

vi.mock("../../services/companion", () => ({
  __esModule: true,
  default: {
    checkHealth: mockCheckHealth,
    getPairStatus: mockGetPairStatus,
    confirmPairing: vi.fn(),
    testPairing: mockTestPairing,
    unpairCurrentOrigin: mockUnpairCurrentOrigin,
    cancelPairing: vi.fn(),
    initiatePairing: vi.fn(),
  },
  clearStoredSecret: vi.fn(),
  hasStoredSecret: mockHasStoredSecret,
  getCompanionAuthProtocolStatus: (health: { auth_protocol_version?: number }) =>
    (health.auth_protocol_version ?? 0) < 2
      ? "companion_update_required"
      : health.auth_protocol_version === 2
        ? "compatible"
        : "browser_update_required",
  isCompanionAuthSignatureMismatch: (error: { response?: { status?: number; data?: { detail?: string } } }) =>
    error.response?.status === 403 && error.response.data?.detail === "Invalid authentication",
}));

function mockNavigatorDevice({
  userAgent,
  platform = "Linux x86_64",
  maxTouchPoints = 0,
}: {
  userAgent: string;
  platform?: string;
  maxTouchPoints?: number;
}) {
  Object.defineProperty(window.navigator, "userAgent", {
    configurable: true,
    value: userAgent,
  });
  Object.defineProperty(window.navigator, "platform", {
    configurable: true,
    value: platform,
  });
  Object.defineProperty(window.navigator, "maxTouchPoints", {
    configurable: true,
    value: maxTouchPoints,
  });
}

describe("LocalDrivesSettings", () => {
  afterEach(() => vi.unstubAllGlobals());

  beforeEach(() => {
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("crypto", { subtle: {} });
    vi.clearAllMocks();
    clearCachedAsyncData();
    mockNavigatorDevice({
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
    });
    mockCheckHealth.mockResolvedValue({ status: "ok", paired: true, auth_protocol_version: 2 });
    mockTestPairing.mockResolvedValue({ status: "success" });
    mockGetCompanionDownloads.mockResolvedValue({
      source: "feed",
      version: "0.5.0",
      published_at: "2026-03-27T12:00:00Z",
      notes: "Release notes",
      assets: {
        "windows-x64": "https://downloads.example.test/Sambee-Companion.exe",
      },
    });
    mockUnpairCurrentOrigin.mockResolvedValue(undefined);
    vi.useRealTimers();
  });

  const renderSettings = () => {
    return render(
      <SambeeThemeProvider>
        <LocalDrivesSettings />
      </SambeeThemeProvider>
    );
  };

  it("does not flash the unavailable warning before the first load resolves", async () => {
    mockCheckHealth.mockReturnValue(new Promise(() => undefined));
    mockHasStoredSecret.mockReturnValue(false);

    await act(async () => {
      renderSettings();
    });

    expect(screen.queryByText(LOCAL_DRIVES_PAGE_COPY.statusUnavailable)).not.toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
  });

  it("requires HTTPS for companion actions on an insecure origin", async () => {
    vi.stubGlobal("isSecureContext", false);
    mockHasStoredSecret.mockReturnValue(true);

    renderSettings();

    expect(await screen.findByText(LOCAL_DRIVES_PAGE_COPY.secureContextMessage)).toBeInTheDocument();
    expect(screen.getByTestId("local-drives-download-surface")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: LOCAL_DRIVES_PAGE_COPY.pairThisBrowserButton })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: LOCAL_DRIVES_PAGE_COPY.testCurrentPairingButton })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: LOCAL_DRIVES_PAGE_COPY.unpairThisBrowserButton })).not.toBeInTheDocument();
    expect(mockCheckHealth).not.toHaveBeenCalled();
    expect(mockGetPairStatus).not.toHaveBeenCalled();
  });

  it("explains missing Web Crypto on a secure origin", async () => {
    vi.stubGlobal("crypto", { getRandomValues: vi.fn() });

    renderSettings();

    expect(await screen.findByText(LOCAL_DRIVES_PAGE_COPY.secureContextMessage)).toHaveTextContent("Web Crypto support");
    expect(screen.getByText(LOCAL_DRIVES_PAGE_COPY.secureContextTitle)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: LOCAL_DRIVES_PAGE_COPY.pairThisBrowserButton })).not.toBeInTheDocument();
  });

  it("shows Unpair This Browser instead of Pair This Browser when this browser is fully paired", async () => {
    mockGetPairStatus.mockResolvedValue({
      current_origin: window.location.origin,
      current_origin_paired: true,
      status: "paired",
    });
    mockHasStoredSecret.mockReturnValue(true);

    renderSettings();

    await waitFor(() => {
      expect(mockGetPairStatus).toHaveBeenCalled();
    });

    expect(screen.queryByRole("button", { name: LOCAL_DRIVES_PAGE_COPY.pairThisBrowserButton })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: LOCAL_DRIVES_PAGE_COPY.unpairThisBrowserButton })).toBeEnabled();
    expect(screen.getByRole("button", { name: LOCAL_DRIVES_PAGE_COPY.testCurrentPairingButton })).toHaveClass("MuiButton-outlined");
    expect(screen.getByRole("button", { name: LOCAL_DRIVES_PAGE_COPY.unpairThisBrowserButton })).toHaveClass("MuiButton-colorError");
    expect(screen.getByTestId("local-drives-summary-surface")).toBeInTheDocument();
    expect(screen.getByTestId("local-drives-verification-surface")).toBeInTheDocument();
    expect(screen.getByTestId("local-drives-troubleshooting-surface")).toBeInTheDocument();
    expect(screen.getByTestId("local-drives-summary-surface").firstElementChild).toHaveClass("MuiStack-root");
    expect(screen.getByTestId("local-drives-verification-surface").firstElementChild?.firstElementChild?.children).toHaveLength(2);
    expect(screen.getByTestId("local-drives-troubleshooting-surface").firstElementChild?.children).toHaveLength(2);
    expect(screen.getByText(LOCAL_DRIVES_PAGE_COPY.verificationSectionTitle)).toBeInTheDocument();
    expect(screen.queryByText(LOCAL_DRIVES_PAGE_COPY.downloadSectionTitle)).not.toBeInTheDocument();
    expect(screen.queryByText(LOCAL_DRIVES_PAGE_COPY.pairingSectionTitle)).not.toBeInTheDocument();
    expect(screen.getByText(LOCAL_DRIVES_PAGE_COPY.statusPaired)).toBeInTheDocument();
  });

  it("shows a persistent inline success status after testing the current pairing", async () => {
    const user = userEvent.setup();
    mockGetPairStatus.mockResolvedValue({
      current_origin: window.location.origin,
      current_origin_paired: true,
      status: "paired",
    });
    mockHasStoredSecret.mockReturnValue(true);
    mockTestPairing.mockResolvedValue({ message: "Pairing with http://localhost:3000 is working." });

    renderSettings();

    await user.click(await screen.findByRole("button", { name: LOCAL_DRIVES_PAGE_COPY.testCurrentPairingButton }));

    const successStatus = await screen.findByRole("status");
    expect(successStatus).toHaveTextContent(LOCAL_DRIVES_PAGE_COPY.pairingTestSucceeded);
    expect(screen.queryByText("Pairing with http://localhost:3000 is working.")).not.toBeInTheDocument();
  });

  it("shows an inline recovery action when testing the current pairing fails", async () => {
    const user = userEvent.setup();
    mockGetPairStatus.mockResolvedValue({
      current_origin: window.location.origin,
      current_origin_paired: true,
      status: "paired",
    });
    mockHasStoredSecret.mockReturnValue(true);
    mockTestPairing.mockResolvedValueOnce({ status: "success" }).mockRejectedValue({
      response: { status: 403, data: { detail: "Invalid authentication" } },
    });

    renderSettings();

    await user.click(await screen.findByRole("button", { name: LOCAL_DRIVES_PAGE_COPY.testCurrentPairingButton }));

    const errorAlert = await screen.findByRole("alert");
    expect(errorAlert).toHaveTextContent(LOCAL_DRIVES_PAGE_COPY.pairingTestFailed);
    expect(screen.getByRole("button", { name: LOCAL_DRIVES_PAGE_COPY.pairThisBrowserButton })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: LOCAL_DRIVES_PAGE_COPY.reloadButton })).toBeInTheDocument();
  });

  it("does not claim readiness when the stored pairing fails verification on load", async () => {
    mockGetPairStatus.mockResolvedValue({ current_origin: window.location.origin, current_origin_paired: true, status: "paired" });
    mockHasStoredSecret.mockReturnValue(true);
    mockTestPairing.mockRejectedValue({ response: { status: 403, data: { detail: "Invalid authentication" } } });

    renderSettings();

    expect(await screen.findByText(LOCAL_DRIVES_PAGE_COPY.statusRecoverable)).toBeInTheDocument();
    expect(screen.queryByText(LOCAL_DRIVES_PAGE_COPY.statusPaired)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: LOCAL_DRIVES_PAGE_COPY.reloadButton })).toBeInTheDocument();
  });

  it("recommends updating an older Companion instead of re-pairing", async () => {
    mockCheckHealth.mockResolvedValue({ status: "ok", paired: true });
    mockGetPairStatus.mockResolvedValue({ current_origin: window.location.origin, current_origin_paired: true, status: "paired" });
    mockHasStoredSecret.mockReturnValue(true);

    renderSettings();

    expect(await screen.findByText(LOCAL_DRIVES_PAGE_COPY.statusUpdateRequired)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Download for this computer/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: LOCAL_DRIVES_PAGE_COPY.pairThisBrowserButton })).not.toBeInTheDocument();
    expect(mockTestPairing).not.toHaveBeenCalled();
  });

  it("recommends updating Sambee instead of Companion for a newer protocol", async () => {
    mockCheckHealth.mockResolvedValue({ status: "ok", paired: true, auth_protocol_version: 3 });
    mockHasStoredSecret.mockReturnValue(true);

    renderSettings();

    expect(await screen.findByText(LOCAL_DRIVES_PAGE_COPY.statusBrowserUpdateRequired)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: LOCAL_DRIVES_PAGE_COPY.reloadButton })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Download for this computer/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: LOCAL_DRIVES_PAGE_COPY.pairThisBrowserButton })).not.toBeInTheDocument();
    expect(mockGetPairStatus).not.toHaveBeenCalled();
  });

  it("does not suggest re-pairing after a temporary verification failure", async () => {
    mockGetPairStatus.mockResolvedValue({ current_origin: window.location.origin, current_origin_paired: true, status: "paired" });
    mockHasStoredSecret.mockReturnValue(true);
    mockTestPairing.mockRejectedValue(new Error("Connection interrupted"));

    renderSettings();

    expect(await screen.findByText(LOCAL_DRIVES_PAGE_COPY.statusVerificationUnavailable)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: LOCAL_DRIVES_PAGE_COPY.testCurrentPairingButton })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: LOCAL_DRIVES_PAGE_COPY.pairThisBrowserButton })).not.toBeInTheDocument();
  });

  it("offers retry instead of re-pairing when the pairing status request fails", async () => {
    const user = userEvent.setup();
    mockGetPairStatus.mockRejectedValue(new Error("Connection interrupted"));
    mockHasStoredSecret.mockReturnValue(false);

    renderSettings();

    expect(await screen.findByText(LOCAL_DRIVES_PAGE_COPY.statusVerificationUnavailable)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: LOCAL_DRIVES_PAGE_COPY.pairThisBrowserButton })).not.toBeInTheDocument();
    mockGetPairStatus.mockResolvedValue({ current_origin: window.location.origin, current_origin_paired: false, status: "unpaired" });
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText(LOCAL_DRIVES_PAGE_COPY.statusUnpaired)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: LOCAL_DRIVES_PAGE_COPY.pairThisBrowserButton })).toBeInTheDocument();
  });

  it("shows Pair This Browser and hides browser-only actions when re-pair is required", async () => {
    mockGetPairStatus.mockResolvedValue({
      current_origin: window.location.origin,
      current_origin_paired: true,
      status: "paired",
    });
    mockHasStoredSecret.mockReturnValue(false);

    renderSettings();

    await waitFor(() => {
      expect(mockGetPairStatus).toHaveBeenCalled();
    });

    expect(screen.getByRole("button", { name: LOCAL_DRIVES_PAGE_COPY.pairThisBrowserButton })).toHaveClass("MuiButton-contained");
    expect(screen.getByTestId("local-drives-pairing-surface")).toBeInTheDocument();
    expect(screen.getByTestId("local-drives-pairing-surface").firstElementChild?.children).toHaveLength(2);
    expect(screen.queryByRole("button", { name: LOCAL_DRIVES_PAGE_COPY.unpairThisBrowserButton })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: LOCAL_DRIVES_PAGE_COPY.testCurrentPairingButton })).not.toBeInTheDocument();
    expect(screen.getByText(LOCAL_DRIVES_PAGE_COPY.pairingSectionTitle)).toBeInTheDocument();
    expect(screen.queryByText(LOCAL_DRIVES_PAGE_COPY.downloadSectionTitle)).not.toBeInTheDocument();
    expect(screen.queryByText(LOCAL_DRIVES_PAGE_COPY.verificationSectionTitle)).not.toBeInTheDocument();
    expect(screen.getByText(LOCAL_DRIVES_PAGE_COPY.statusRecoverable)).toBeInTheDocument();
    expect(screen.getByText(LOCAL_DRIVES_PAGE_COPY.pairingSectionRepair)).toBeInTheDocument();
  });

  it("shows a waiting state while local companion approval is still pending", async () => {
    mockGetPairStatus.mockResolvedValue({
      current_origin: window.location.origin,
      current_origin_paired: false,
      status: "pending_local_approval",
    });
    mockHasStoredSecret.mockReturnValue(false);

    renderSettings();

    await waitFor(() => {
      expect(mockGetPairStatus).toHaveBeenCalled();
    });

    expect(screen.getByText(LOCAL_DRIVES_PAGE_COPY.statusPendingApproval)).toBeInTheDocument();
    expect(screen.getByText(LOCAL_DRIVES_PAGE_COPY.pairingSectionPendingApproval)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: LOCAL_DRIVES_PAGE_COPY.waitingForApprovalButton })).toBeDisabled();
    expect(screen.queryByRole("button", { name: LOCAL_DRIVES_PAGE_COPY.testCurrentPairingButton })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: LOCAL_DRIVES_PAGE_COPY.unpairThisBrowserButton })).not.toBeInTheDocument();
  });

  it("unpairs the current browser from the top-level action", async () => {
    const user = userEvent.setup();

    mockGetPairStatus.mockResolvedValue({
      current_origin: window.location.origin,
      current_origin_paired: true,
      status: "paired",
    });
    mockHasStoredSecret.mockReturnValue(true);

    renderSettings();

    const unpairButton = await screen.findByRole("button", { name: LOCAL_DRIVES_PAGE_COPY.unpairThisBrowserButton });
    await user.click(unpairButton);

    await waitFor(() => {
      expect(mockUnpairCurrentOrigin).toHaveBeenCalled();
    });
  });

  it("shows backend-provided companion download links", async () => {
    mockCheckHealth.mockResolvedValue(null);
    mockGetPairStatus.mockResolvedValue({
      current_origin: window.location.origin,
      current_origin_paired: false,
      status: "unpaired",
    });
    mockHasStoredSecret.mockReturnValue(false);

    renderSettings();

    expect(await screen.findByText(LOCAL_DRIVES_PAGE_COPY.downloadSectionTitle)).toBeInTheDocument();
    const downloadLink = screen.getByRole("link", { name: /Download for this computer/i });
    expect(downloadLink).toHaveAttribute("href", "https://downloads.example.test/Sambee-Companion.exe");
    expect(downloadLink).toHaveClass("MuiButton-contained");
    expect(screen.getByTestId("local-drives-download-surface")).toBeInTheDocument();
    expect(screen.getByTestId("local-drives-download-surface").firstElementChild?.children).toHaveLength(2);
  });

  it("shows an actionable metadata error when companion downloads cannot be resolved", async () => {
    mockCheckHealth.mockResolvedValue(null);
    mockGetPairStatus.mockResolvedValue({
      current_origin: window.location.origin,
      current_origin_paired: false,
      status: "unpaired",
    });
    mockHasStoredSecret.mockReturnValue(false);
    mockGetCompanionDownloads.mockRejectedValue({
      response: { data: { detail: "Companion download metadata feed request timed out." } },
      message: "Bad Gateway",
    });

    renderSettings();

    expect(await screen.findByText("Companion download metadata feed request timed out.")).toBeInTheDocument();
  });

  it("uses a slower steady-state poll interval after pairing is already healthy", async () => {
    mockGetPairStatus.mockResolvedValue({
      current_origin: window.location.origin,
      current_origin_paired: true,
      status: "paired",
    });
    mockHasStoredSecret.mockReturnValue(true);
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");

    renderSettings();

    await waitFor(() => {
      expect(mockCheckHealth).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 15_000);
    });
  });

  it("hides Companion install and pairing UI on unsupported mobile platforms", async () => {
    mockNavigatorDevice({
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1",
      platform: "iPhone",
      maxTouchPoints: 5,
    });
    mockHasStoredSecret.mockReturnValue(false);

    renderSettings();

    expect(await screen.findByText(LOCAL_DRIVES_PAGE_COPY.unsupportedMobileTitle)).toBeInTheDocument();
    expect(screen.getByText(LOCAL_DRIVES_PAGE_COPY.unsupportedMobileAlert)).toBeInTheDocument();
    expect(screen.queryByText(LOCAL_DRIVES_PAGE_COPY.summaryTitle)).not.toBeInTheDocument();
    expect(screen.queryByText(LOCAL_DRIVES_PAGE_COPY.downloadSectionTitle)).not.toBeInTheDocument();
    expect(screen.queryByText(LOCAL_DRIVES_PAGE_COPY.pairingSectionTitle)).not.toBeInTheDocument();
    expect(screen.queryByText(LOCAL_DRIVES_PAGE_COPY.verificationSectionTitle)).not.toBeInTheDocument();
    expect(mockCheckHealth).not.toHaveBeenCalled();
    expect(mockGetCompanionDownloads).not.toHaveBeenCalled();
    expect(mockGetPairStatus).not.toHaveBeenCalled();
  });
});
