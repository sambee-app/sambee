import { expect, test } from "@playwright/test";

const DEMO_PAGE = "/browse/smb/demo";
const AUTH_RECOVERY_TIMEOUT_MS = 60_000;
const ACCESS_TOKEN_LIFETIME_MS = 60 * 60_000;
const TAB_COUNT = 4;

for (const broadcastsEnabled of [true, false]) {
  test(`development OIDC recovery restores four tabs with broadcasts ${broadcastsEnabled ? "enabled" : "unavailable"}`, async ({
    context,
    page,
  }) => {
    test.setTimeout(AUTH_RECOVERY_TIMEOUT_MS);
    let signedIn = true;
    let returnPath = "/browse";
    let loginGeneration = 1;

    if (!broadcastsEnabled) {
      await context.addInitScript(() => {
        Object.defineProperty(window, "BroadcastChannel", { value: undefined });
      });
    }

    await context.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const token = {
        access_token: `browser-test-session-${loginGeneration}`,
        token_type: "bearer",
        user_id: "browser-test-user",
        username: "browser-test-user",
        role: "admin",
        access_token_expires_at: new Date(Date.now() + ACCESS_TOKEN_LIFETIME_MS).toISOString(),
        oidc_refresh_generation: 1,
      };
      switch (url.pathname) {
        case "/api/auth/config":
          await route.fulfill({
            json: {
              sign_in_mode: "oidc_or_password",
              oidc: { display_name: "Test identity", authorization_path: "/api/auth/oidc/authorize" },
            },
          });
          return;
        case "/api/auth/oidc/authorize":
          returnPath = url.searchParams.get("return_path") ?? "/browse";
          await route.fulfill({ status: 302, headers: { location: "/login/oidc/callback#grant=browser-test-grant" } });
          return;
        case "/api/auth/oidc/exchange":
          signedIn = true;
          loginGeneration += 1;
          await route.fulfill({ json: { ...token, access_token: `browser-test-session-${loginGeneration}`, return_path: returnPath } });
          return;
        case "/api/auth/oidc/logout":
          signedIn = false;
          await route.fulfill({ status: 204 });
          return;
        case "/api/auth/oidc/refresh":
        case "/api/auth/me":
          await route.fulfill(
            signedIn
              ? { json: { ...token, id: token.user_id, is_active: true } }
              : { status: 401, json: { detail: { code: "oidc_reauthentication_required" } } }
          );
          return;
        default: {
          const headers = { ...request.headers() };
          delete headers["authorization"];
          await route.continue({ headers });
        }
      }
    });

    const tabs = [page];
    for (let tabIndex = 1; tabIndex < TAB_COUNT; tabIndex += 1) tabs.push(await context.newPage());
    await page.setViewportSize({ width: 390, height: 844 });
    const destinations = tabs.map((_, tabIndex) => `${DEMO_PAGE}?auth_tab=${tabIndex}`);
    for (const [tabIndex, tab] of tabs.entries()) {
      await tab.goto(destinations[tabIndex]);
      await expect(tab.getByRole("button", { name: tabIndex === 0 ? "Open menu" : "Open settings", exact: true })).toBeVisible();
    }

    await page.bringToFront();
    await page.getByRole("button", { name: "Open menu", exact: true }).click();
    await page.getByRole("button", { name: "Logout", exact: true }).click();
    await expect(page.getByRole("textbox", { name: /username/i })).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem("sambee_oidc_return_path"))).toBeNull();

    for (const tab of tabs.slice(1)) {
      await tab.bringToFront();
      await tab.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(tab.getByRole("textbox", { name: /username/i })).toBeVisible();
    }

    await page.bringToFront();
    await page.getByRole("button", { name: /sign in with sso/i }).click();
    await expect(page.getByRole("button", { name: "Open menu", exact: true })).toBeVisible();
    expect(new URL(page.url()).searchParams.has("auth_tab")).toBe(false);
    expect(returnPath).toBe("/browse");

    for (const [tabIndex, tab] of tabs.entries()) {
      if (tabIndex === 0) continue;
      if (!broadcastsEnabled) {
        await tab.bringToFront();
        await tab.evaluate(() => window.dispatchEvent(new Event("focus")));
      }
      await expect(tab).toHaveURL(new RegExp(`${destinations[tabIndex].replace("?", "\\?")}$`));
      await expect(tab.getByRole("button", { name: "Open settings", exact: true })).toBeVisible();
    }
  });
}
