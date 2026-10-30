import { describe, expect, it } from "vitest";
import { classifyFileFailure, getApiErrorMessage, getOidcMappingValidationErrors, normalizePhysicalFileFailure } from "../apiErrors";

describe("physical file failure classification", () => {
  it("decodes bounded declared JSON for text reads without treating HTML or untyped strings as absence", async () => {
    for (const [contentType, body, expectedKind] of [
      ["application/json", JSON.stringify({ detail: { code: "item_not_found" } }), "missing"],
      ["application/problem+json", JSON.stringify({ code: "file_access_denied" }), "access_denied"],
      ["text/html", '<html>{"code":"item_not_found"}</html>', "unknown"],
      [undefined, JSON.stringify({ code: "item_not_found" }), "unknown"],
      ["application/json", `{${" ".repeat(64 * 1024)}"code":"item_not_found"}`, "unknown"],
    ] as const) {
      const originalError = { response: { status: 404, headers: { "content-type": contentType }, data: body } };
      const failure = await normalizePhysicalFileFailure(originalError, "draft.txt");
      expect(failure.failure.kind).toBe(expectedKind);
      expect(failure.cause).toBe(originalError);
    }
  });

  it("decodes a structured JSON blob but does not infer absence from HTML or broken JSON", async () => {
    for (const [payload, kind] of [
      [
        new Blob([JSON.stringify({ detail: { code: "item_not_found", message: "private path" } })], { type: "application/json" }),
        "missing",
      ],
      [new Blob(["<html>not found</html>"], { type: "text/html" }), "unknown"],
      [new Blob(["{"], { type: "application/json" }), "unknown"],
    ] as const) {
      const originalError = { response: { status: 404, data: payload } };
      const failure = await normalizePhysicalFileFailure(originalError, "folder/draft.txt");
      expect(failure.failure.kind).toBe(kind);
      expect(failure.cause).toBe(originalError);
      expect(getApiErrorMessage(failure, "fallback")).not.toContain("private path");
    }
  });
  it.each(["item_not_found", "recent_file_target_missing", "local_link_target_missing"])(
    "accepts missing code %s in both envelopes",
    (code) => {
      for (const data of [{ code, detail: "private SMB path" }, { detail: { code, message: "private SMB path" } }]) {
        expect(classifyFileFailure({ response: { status: 404, data } }, "docs/draft.txt")).toEqual({
          kind: "missing",
          message: 'File "draft.txt" was not found. It may have been moved or deleted.',
        });
      }
    }
  );

  it.each([undefined, "connection_not_found", "recent_file_native_launch_failed", "token_expired", "archive_member_not_found"])(
    "does not infer physical absence from a 404 with %s",
    (code) => {
      expect(classifyFileFailure({ response: { status: 404, data: { code, detail: "private OS path" } } }, "draft.txt").kind).not.toBe(
        "missing"
      );
    }
  );
});

describe("Archive V2 API errors", () => {
  it("extracts top-level messages from V2 responses", () => {
    const message = "Archive creation source changed after manifest validation";
    expect(getApiErrorMessage({ response: { status: 409, data: { code: "source_changed", message } } }, "fallback")).toBe(message);
  });

  it.each([undefined, null, "", "  ", 409, {}])("ignores invalid V2 message %j", (message) => {
    expect(getApiErrorMessage({ response: { status: 409, data: { message } } }, "fallback")).toBe("fallback");
  });

  it("keeps support for legacy detail messages", () => {
    expect(getApiErrorMessage({ response: { data: { detail: "Legacy error", message: "V2 error" } } }, "fallback")).toBe("Legacy error");
  });
});

describe("OIDC mapping API errors", () => {
  it("extracts all row-keyed validation errors and their messages", () => {
    const errors = [
      {
        target_user_id: "user-1",
        field: "expected_username",
        error_code: "oidc_mapping_duplicate_username",
        message: "Provider username must be unique",
      },
      {
        target_user_id: "user-2",
        field: "target_user_id",
        error_code: "oidc_mapping_target_unavailable",
        message: "OIDC mapping target is unavailable",
      },
    ];
    const apiError = { response: { data: { detail: { errors } }, status: 409 } };

    expect(getOidcMappingValidationErrors(apiError)).toEqual(errors);
    expect(getApiErrorMessage(apiError, "fallback")).toBe("Provider username must be unique OIDC mapping target is unavailable");
  });

  it("extracts the message from a structured error detail", () => {
    const apiError = { response: { data: { detail: { code: "edit_lock_lost", message: "Lock not found or expired" } }, status: 404 } };

    expect(getApiErrorMessage(apiError, "fallback")).toBe("Lock not found or expired");
  });
});
