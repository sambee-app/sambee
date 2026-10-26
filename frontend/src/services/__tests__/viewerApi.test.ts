import { requireTestValue } from "../../test/helpers/assertions";
/**
 * Contract tests for Viewer API
 *
 * Ensures frontend types match backend API responses for viewer endpoints
 * Tests binary responses (Blob) for images, PDFs, and downloads
 */

import type { AxiosResponse } from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock axios before importing services
vi.mock("axios", () => {
  const mockAxiosInstance = {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    interceptors: {
      request: {
        use: vi.fn(),
        eject: vi.fn(),
      },
      response: {
        use: vi.fn(),
        eject: vi.fn(),
      },
    },
  };

  return {
    default: {
      create: vi.fn(() => mockAxiosInstance),
      isCancel: vi.fn(() => false),
      isAxiosError: vi.fn(() => true),
    },
  };
});

import axios from "axios";
import { apiService, PDF_VIEWER_REQUEST_TIMEOUT_MS } from "../api";

const mockedAxios = vi.mocked(axios);
const mockAxiosInstance = mockedAxios.create() as ReturnType<typeof mockedAxios.create> & {
  get: ReturnType<typeof vi.fn>;
};

describe("Viewer API Contract Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  const testConnectionId = "123e4567-e89b-12d3-a456-426614174000";
  const testPath = "/documents/test.pdf";

  describe("Contract Tests - GET /viewer/{connection_id}/file (Image Blob)", () => {
    it("should return Blob for images", async () => {
      // Create mock image data
      const imageData = new ArrayBuffer(1024);
      const backendResponse = {
        data: imageData,
        status: 200,
        statusText: "OK",
        headers: {
          "content-type": "image/jpeg",
        },
        config: {},
      };

      mockAxiosInstance.get.mockResolvedValueOnce(backendResponse as unknown as unknown as AxiosResponse);

      const result = await apiService.getImageBlob(testConnectionId, "/images/photo.jpg");

      // Verify it's a Blob
      expect(result).toBeInstanceOf(Blob);

      // Verify Blob type
      expect(result.type).toBe("image/jpeg");

      // Verify Blob size
      expect(result.size).toBeGreaterThan(0);
    });

    it("should include correct Content-Type header for different image types", async () => {
      const testCases = [
        { contentType: "image/jpeg", path: "/photo.jpg" },
        { contentType: "image/png", path: "/image.png" },
        { contentType: "image/gif", path: "/animation.gif" },
        { contentType: "image/webp", path: "/modern.webp" },
      ];

      for (const testCase of testCases) {
        vi.clearAllMocks();

        const imageData = new ArrayBuffer(512);
        mockAxiosInstance.get.mockResolvedValueOnce({
          data: imageData,
          status: 200,
          statusText: "OK",
          headers: {
            "content-type": testCase.contentType,
          },
          config: {},
        } as unknown as AxiosResponse);

        const result = await apiService.getImageBlob(testConnectionId, testCase.path);

        expect(result.type).toBe(testCase.contentType);
      }
    });

    it("should handle viewport dimensions parameters", async () => {
      const imageData = new ArrayBuffer(2048);
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: imageData,
        status: 200,
        statusText: "OK",
        headers: { "content-type": "image/jpeg" },
        config: {},
      } as unknown as AxiosResponse);

      await apiService.getImageBlob(testConnectionId, "/large.jpg", {
        viewportWidth: 1920,
        viewportHeight: 1080,
      });

      // Verify request included viewport parameters
      const callArgs = requireTestValue(mockAxiosInstance.get.mock.calls[0]);
      expect(callArgs[0]).toBe(`/viewer/${testConnectionId}/file`);
      expect(callArgs[1]?.params).toHaveProperty("viewport_width");
      expect(callArgs[1]?.params).toHaveProperty("viewport_height");
    });

    it("should handle no_resizing parameter", async () => {
      const imageData = new ArrayBuffer(1024);
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: imageData,
        status: 200,
        statusText: "OK",
        headers: { "content-type": "image/png" },
        config: {},
      } as unknown as AxiosResponse);

      await apiService.getImageBlob(testConnectionId, "/original.png", {
        no_resizing: true,
      });

      // Verify no_resizing parameter was sent
      const callArgs = requireTestValue(mockAxiosInstance.get.mock.calls[0]);
      expect(callArgs[1]?.params).toHaveProperty("no_resizing", 1);
    });

    it("should handle abort signal for cancellation", async () => {
      const imageData = new ArrayBuffer(1024);
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: imageData,
        status: 200,
        statusText: "OK",
        headers: { "content-type": "image/jpeg" },
        config: {},
      } as unknown as AxiosResponse);

      const abortController = new AbortController();
      await apiService.getImageBlob(testConnectionId, "/photo.jpg", {
        signal: abortController.signal,
      });

      // Verify signal was passed
      const callArgs = requireTestValue(mockAxiosInstance.get.mock.calls[0]);
      expect(callArgs[1]?.signal).toBe(abortController.signal);
    });

    it("should return fallback content-type if header missing", async () => {
      const imageData = new ArrayBuffer(512);
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: imageData,
        status: 200,
        statusText: "OK",
        headers: {}, // No content-type
        config: {},
      } as unknown as AxiosResponse);

      const result = await apiService.getImageBlob(testConnectionId, "/unknown.img");

      // Should default to application/octet-stream
      expect(result.type).toBe("application/octet-stream");
    });
  });

  describe("Contract Tests - GET /viewer/{connection_id}/file (PDF Blob)", () => {
    it("should return Blob for PDFs", async () => {
      const pdfData = new ArrayBuffer(4096);
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: pdfData,
        status: 200,
        statusText: "OK",
        headers: {
          "content-type": "application/pdf",
        },
        config: {},
      } as unknown as AxiosResponse);

      const result = await apiService.getPdfBlob(testConnectionId, testPath);

      // Verify it's a Blob
      expect(result).toBeInstanceOf(Blob);

      // Verify Blob type
      expect(result.type).toBe("application/pdf");

      // Verify Blob size
      expect(result.size).toBeGreaterThan(0);
    });

    it("should include correct Content-Type header for PDF", async () => {
      const pdfData = new ArrayBuffer(2048);
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: pdfData,
        status: 200,
        statusText: "OK",
        headers: {
          "content-type": "application/pdf",
        },
        config: {},
      } as unknown as AxiosResponse);

      const result = await apiService.getPdfBlob(testConnectionId, "/report.pdf");

      expect(result.type).toBe("application/pdf");
    });

    it("should handle abort signal for PDF cancellation", async () => {
      const pdfData = new ArrayBuffer(1024);
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: pdfData,
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/pdf" },
        config: {},
      } as unknown as AxiosResponse);

      const abortController = new AbortController();
      await apiService.getPdfBlob(testConnectionId, "/document.pdf", {
        signal: abortController.signal,
      });

      // Verify signal was passed
      const callArgs = requireTestValue(mockAxiosInstance.get.mock.calls[0]);
      expect(callArgs[1]?.signal).toBe(abortController.signal);
    });

    it("should request the explicit normalized PDF variant", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: new ArrayBuffer(1024),
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/pdf" },
        config: {},
      } as unknown as AxiosResponse);

      await apiService.getPdfBlob(testConnectionId, "/document.pdf", { pdfVariant: "normalized" });

      expect(requireTestValue(mockAxiosInstance.get.mock.calls[0])[1]?.params).toEqual({
        path: "/document.pdf",
        pdf_variant: "normalized",
      });
    });

    it("should include the physical display profile for compatibility selection", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: new ArrayBuffer(1024),
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/pdf" },
        config: {},
      } as unknown as AxiosResponse);

      await apiService.getPdfBlob(testConnectionId, "/document.pdf", {
        pdfVariant: "normalized",
        screenProfile: { width: 5120, height: 2880, zoomPercent: 200 },
      });

      expect(requireTestValue(mockAxiosInstance.get.mock.calls[0])[1]?.params).toEqual({
        path: "/document.pdf",
        pdf_variant: "normalized",
        screen_width: 5120,
        screen_height: 2880,
        screen_zoom_percent: 200,
      });
    });

    it("should default to application/pdf if content-type missing", async () => {
      const pdfData = new ArrayBuffer(1024);
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: pdfData,
        status: 200,
        statusText: "OK",
        headers: {}, // No content-type
        config: {},
      } as unknown as AxiosResponse);

      const result = await apiService.getPdfBlob(testConnectionId, testPath);

      // Should default to application/pdf
      expect(result.type).toBe("application/pdf");
    });
  });

  describe("Contract Tests - Error Handling", () => {
    it("should handle 404 errors for missing images", async () => {
      mockAxiosInstance.get.mockRejectedValueOnce({
        response: {
          status: 404,
          data: new ArrayBuffer(0),
          headers: {},
        },
        isAxiosError: true,
      });

      await expect(apiService.getImageBlob(testConnectionId, "/missing.jpg")).rejects.toMatchObject({
        response: {
          status: 404,
        },
      });
    });

    it("should handle 403 access denied for images", async () => {
      mockAxiosInstance.get.mockRejectedValueOnce({
        response: {
          status: 403,
          data: new ArrayBuffer(0),
          headers: {},
        },
        isAxiosError: true,
      });

      await expect(apiService.getImageBlob(testConnectionId, "/restricted.jpg")).rejects.toMatchObject({
        response: {
          status: 403,
        },
      });
    });

    it("should handle 404 errors for missing PDFs", async () => {
      mockAxiosInstance.get.mockRejectedValueOnce({
        response: {
          status: 404,
          data: new ArrayBuffer(0),
          headers: {},
        },
        isAxiosError: true,
      });

      await expect(apiService.getPdfBlob(testConnectionId, "/missing.pdf")).rejects.toMatchObject({
        response: {
          status: 404,
        },
      });
    });

    it("should handle 413 payload too large for PDFs", async () => {
      mockAxiosInstance.get.mockRejectedValueOnce({
        response: {
          status: 413,
          data: new ArrayBuffer(0),
          headers: {},
        },
        isAxiosError: true,
      });

      await expect(apiService.getPdfBlob(testConnectionId, "/huge.pdf")).rejects.toMatchObject({
        response: {
          status: 413,
        },
      });
    });

    it("should handle network errors for images", async () => {
      mockAxiosInstance.get.mockRejectedValueOnce(new Error("Network error"));

      await expect(apiService.getImageBlob(testConnectionId, "/photo.jpg")).rejects.toThrow("Network error");
    });

    it("should handle network errors for PDFs", async () => {
      mockAxiosInstance.get.mockRejectedValueOnce(new Error("Connection timeout"));

      await expect(apiService.getPdfBlob(testConnectionId, "/document.pdf")).rejects.toThrow("Connection timeout");
    });

    it("should handle 500 server errors", async () => {
      mockAxiosInstance.get.mockRejectedValueOnce({
        response: {
          status: 500,
          data: new ArrayBuffer(0),
          headers: {},
        },
        isAxiosError: true,
      });

      await expect(apiService.getImageBlob(testConnectionId, "/error.jpg")).rejects.toMatchObject({
        response: {
          status: 500,
        },
      });
    });
  });

  describe("Contract Tests - PDF viewer request timeout", () => {
    it("uses the bounded PDF viewer timeout", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: new ArrayBuffer(128),
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/pdf" },
        config: {},
      } as unknown as AxiosResponse);

      await apiService.getPdfBlob(testConnectionId, testPath);

      expect(mockAxiosInstance.get).toHaveBeenCalledWith(
        `/viewer/${testConnectionId}/file`,
        expect.objectContaining({
          timeout: PDF_VIEWER_REQUEST_TIMEOUT_MS,
        })
      );
    });
  });

  describe("Contract Tests - GET /viewer/{connection_id}/download", () => {
    it("does not expose a bearer token in the download URL", async () => {
      const url = await apiService.getDownloadUrl(testConnectionId, testPath);

      // Verify URL structure
      expect(url).toContain("/api/viewer/");
      expect(url).toContain(testConnectionId);
      expect(url).toContain("/download");
      expect(url).toContain("path=");
      expect(url).not.toContain("token=");
    });

    it("should encode path parameter correctly", async () => {
      const specialPath = "/folder/file with spaces & special.txt";
      const url = await apiService.getDownloadUrl(testConnectionId, specialPath);

      // Path should be URL encoded
      expect(url).toContain(encodeURIComponent(specialPath));
    });
  });

  describe("Contract Tests - GET /viewer/{connection_id}/file (View URL)", () => {
    it("does not expose a bearer token in the view URL", async () => {
      const url = await apiService.getViewUrl(testConnectionId, "/image.jpg");

      // Verify URL structure
      expect(url).toContain("/api/viewer/");
      expect(url).toContain(testConnectionId);
      expect(url).toContain("/file");
      expect(url).toContain("path=");
      expect(url).not.toContain("token=");
    });

    it("should encode path parameter in view URL", async () => {
      const pathWithUnicode = "/files/文档.pdf";
      const url = await apiService.getViewUrl(testConnectionId, pathWithUnicode);

      // Path should be URL encoded
      expect(url).toContain(encodeURIComponent(pathWithUnicode));
    });
  });
});
