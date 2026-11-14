import createCache from "@emotion/cache";
import { CacheProvider } from "@emotion/react";
import { type RenderOptions, render } from "@testing-library/react";
import { Fragment, type ReactElement } from "react";
import { onTestFinished } from "vitest";

/** Keep generated styles until unmount, but do not retain them across tests. */
export function renderWithStyles(ui: ReactElement, options: RenderOptions = {}) {
  const cache = createCache({ key: "test", speedy: true });
  // RTL cleanup unmounts all roots before test-finished callbacks run.
  onTestFinished(() => cache.sheet.flush());
  const { wrapper: Wrapper = Fragment, ...renderOptions } = options;
  return render(ui, {
    ...renderOptions,
    wrapper: ({ children }) => (
      <CacheProvider value={cache}>
        <Wrapper>{children}</Wrapper>
      </CacheProvider>
    ),
  });
}
