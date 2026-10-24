import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import api from "../../../services/api";
import { render } from "../../../test/utils/test-utils";
import { editableDefinition } from "../../../theme/themeDefinition";
import { builtInThemes } from "../../../theme/themes";
import { ThemeEditorDialog } from "../ThemeEditorDialog";

const theme = builtInThemes[0]!;

function renderEditor() {
  const onClose = vi.fn();
  const onSaved = vi.fn().mockResolvedValue(undefined);
  render(<ThemeEditorDialog theme={theme} stored={undefined} storedThemes={[]} isAdmin={false} onClose={onClose} onSaved={onSaved} />);
  return { onClose, onSaved };
}

async function chooseCopyDestination(user: ReturnType<typeof userEvent.setup>, destination = "Your themes") {
  await user.click(screen.getByRole("button", { name: "Save copy" }));
  await user.click(screen.getByRole("menuitem", { name: destination }));
}

describe("ThemeEditorDialog", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("starts on the dialog and tabs to the name field", async () => {
    const user = userEvent.setup();
    renderEditor();

    expect(screen.getByRole("dialog", { name: `Edit ${theme.name} (built-in)` })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveFocus();
  });

  it("uses small controls with only external labels on desktop", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query === "(min-width:900px)",
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }))
    );
    renderEditor();

    for (const [id, name] of [
      ["theme-name", "Name"],
      ["theme-description", "Description"],
      ["primary.main-input", "Main"],
    ]) {
      const input = screen.getByRole("textbox", { name });
      expect(input).toHaveAttribute("id", id);
      expect(input.closest(".MuiInputBase-root")).toHaveClass("MuiInputBase-sizeSmall");
      expect(document.querySelector(`label.MuiInputLabel-root[for="${id}"]`)).not.toBeInTheDocument();
    }
    expect(screen.getByRole("combobox", { name: "Mode" }).closest(".MuiInputBase-root")).toHaveClass("MuiInputBase-sizeSmall");
    expect(document.querySelector('label.MuiInputLabel-root[for="theme-mode"]')).not.toBeInTheDocument();
  });

  it.each([
    ["user", "personal"],
    ["site", "site"],
  ] as const)("labels a %s theme as %s in the editor title", (scope, label) => {
    const stored = { id: theme.id, scope, version: 1, definition: editableDefinition(theme) };
    render(
      <ThemeEditorDialog
        theme={theme}
        stored={stored}
        storedThemes={[stored]}
        isAdmin={scope === "site"}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    );

    expect(screen.getByRole("dialog", { name: `Edit ${theme.name} (${label})` })).toBeInTheDocument();
  });

  it("keeps an invalid hex draft local and cancels without saving", async () => {
    const user = userEvent.setup();
    const create = vi.spyOn(api, "createTheme");
    const { onClose } = renderEditor();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    await user.clear(screen.getByDisplayValue(theme.primary.main));
    await user.type(screen.getByRole("textbox", { name: /Main/ }), "#bad");
    expect(screen.getByRole("textbox", { name: /Main/ })).toHaveAttribute("aria-invalid", "true");
    expect(document.querySelector('label.MuiInputLabel-root[for="primary.main-input"]')).toHaveTextContent("Main");
    expect(screen.getByRole("textbox", { name: /Main/ })).toHaveAccessibleDescription("Use #RRGGBB or #RRGGBBAA.");
    await chooseCopyDestination(user);
    await waitFor(() => expect(screen.getByRole("textbox", { name: /Main/ })).toHaveFocus());
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("keeps valid color and description edits local until Save", async () => {
    const user = userEvent.setup();
    const create = vi.spyOn(api, "createTheme");
    const { onClose, onSaved } = renderEditor();

    await user.clear(screen.getByRole("textbox", { name: /Main/ }));
    await user.type(screen.getByRole("textbox", { name: /Main/ }), "#112233");
    await user.type(screen.getByRole("textbox", { name: "Description" }), "Local draft");
    expect(screen.getByRole("textbox", { name: /Main/ })).toHaveValue("#112233");
    expect(create).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
  });

  it("edits syntax through the existing picker, validation focus and copy workflow", async () => {
    const user = userEvent.setup();
    const create = vi.spyOn(api, "createTheme").mockResolvedValue({ id: "syntax-copy", version: 1, scope: "user", definition: theme });
    const original = structuredClone(theme.components!.syntax);
    renderEditor();
    await user.click(screen.getByRole("button", { name: "Syntax" }));
    await user.click(screen.getByRole("button", { name: "Choose Keyword color" }));
    expect(document.querySelector(".react-colorful__alpha")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    const keyword = screen.getByRole("textbox", { name: "Keyword" });
    await user.clear(keyword);
    await user.type(keyword, "invalid");
    await chooseCopyDestination(user);
    await waitFor(() => expect(keyword).toHaveFocus());
    expect(keyword).toHaveAttribute("aria-invalid", "true");
    expect(create).not.toHaveBeenCalled();
    await user.clear(keyword);
    await user.type(keyword, "#12345678");
    expect(theme.components!.syntax).toEqual(original);
    await chooseCopyDestination(user);
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          components: expect.objectContaining({ syntax: { ...original, keyword: "#12345678" } }),
        }),
        "user"
      )
    );
  });

  it("discards syntax edits on Cancel without changing the active definition", async () => {
    const user = userEvent.setup();
    const create = vi.spyOn(api, "createTheme");
    const { onClose } = renderEditor();
    const original = structuredClone(theme.components!.syntax);
    await user.click(screen.getByRole("button", { name: "Syntax" }));
    const keyword = screen.getByRole("textbox", { name: "Keyword" });
    await user.clear(keyword);
    await user.type(keyword, "#123456");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(create).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
    expect(theme.components!.syntax).toEqual(original);
  });

  it("offers an alpha picker and saves a copied built-in with a server-generated ID", async () => {
    const user = userEvent.setup();
    const created = vi.spyOn(api, "createTheme").mockResolvedValue({ id: "server-id", version: 1, scope: "user", definition: theme });
    const { onSaved } = renderEditor();
    await user.click(screen.getByRole("button", { name: "Choose Main color" }));
    expect(document.querySelector(".react-colorful__alpha")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.clear(screen.getByDisplayValue(theme.name));
    await user.type(screen.getByRole("textbox", { name: /Name/ }), "Custom light");
    await user.clear(screen.getByRole("textbox", { name: /Main/ }));
    await user.type(screen.getByRole("textbox", { name: /Main/ }), "#11223388");
    await chooseCopyDestination(user);
    await waitFor(() =>
      expect(created).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Custom light", primary: expect.objectContaining({ main: "#11223388" }) }),
        "user"
      )
    );
    expect(onSaved).toHaveBeenCalledWith("server-id", true);
  });

  it("shows and saves opaque eight-digit input as six-digit hex", async () => {
    const user = userEvent.setup();
    const create = vi.spyOn(api, "createTheme").mockResolvedValue({ id: "server-id", version: 1, scope: "user", definition: theme });
    renderEditor();
    const main = screen.getByRole("textbox", { name: /Main/ });
    await user.clear(main);
    await user.type(main, "#112233ff");
    await user.tab();

    expect(main).toHaveValue("#112233");
    await chooseCopyDestination(user);
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ primary: expect.objectContaining({ main: "#112233" }) }), "user")
    );
  });

  it("updates a writable theme using the versioned target", async () => {
    const user = userEvent.setup();
    const writableTheme = { ...theme, id: "custom-id", name: "Writable" };
    const stored = { id: "custom-id", scope: "user" as const, version: 3, definition: editableDefinition(writableTheme) };
    const updated = { ...stored, version: 4 };
    const update = vi.spyOn(api, "updateTheme").mockResolvedValue(updated);
    const onSaved = vi.fn().mockResolvedValue(undefined);
    render(
      <ThemeEditorDialog
        theme={writableTheme}
        stored={stored}
        storedThemes={[stored]}
        isAdmin={false}
        onClose={vi.fn()}
        onSaved={onSaved}
      />
    );

    await user.clear(screen.getByDisplayValue("Writable"));
    await user.type(screen.getByRole("textbox", { name: /Name/ }), "Updated");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(update).toHaveBeenCalledWith(stored, expect.objectContaining({ name: "Updated" })));
    expect(onSaved).toHaveBeenCalledWith(stored.id, false);
  });

  it("exports a versioned draft without an editable identity", async () => {
    const user = userEvent.setup();
    let downloaded: Blob | undefined;
    const originalCreate = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const originalRevoke = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: (blob: Blob) => {
        downloaded = blob;
        return "blob:theme-export";
      },
    });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    try {
      renderEditor();
      await user.click(screen.getByRole("button", { name: "Export" }));
      const json = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsText(downloaded!);
      });
      const exported = JSON.parse(json);
      expect(exported).toMatchObject({ version: 1, definition: { name: theme.name } });
      expect(exported.definition).not.toHaveProperty("id");
    } finally {
      if (originalCreate) Object.defineProperty(URL, "createObjectURL", originalCreate);
      else Reflect.deleteProperty(URL, "createObjectURL");
      if (originalRevoke) Object.defineProperty(URL, "revokeObjectURL", originalRevoke);
      else Reflect.deleteProperty(URL, "revokeObjectURL");
    }
  });

  it("imports a valid draft without saving and leaves it intact after an invalid import", async () => {
    const user = userEvent.setup();
    renderEditor();
    const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const validFile = new File([], "theme.json", { type: "application/json" });
    validFile.text = async () => JSON.stringify({ version: 1, definition: { ...editableDefinition(theme), name: "Imported light" } });

    await user.upload(fileInput, validFile);
    expect(await screen.findByDisplayValue("Imported light")).toBeInTheDocument();

    const invalidFile = new File([], "broken.json", { type: "application/json" });
    invalidFile.text = async () => "{broken";
    await user.upload(fileInput, invalidFile);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Imported light")).toBeInTheDocument();
  });

  it("shows the invalid JSON color path and value beside Import without replacing the draft", async () => {
    const user = userEvent.setup();
    renderEditor();
    const invalidFile = new File([], "broken.json", { type: "application/json" });
    invalidFile.text = async () =>
      JSON.stringify({
        version: 1,
        definition: {
          ...editableDefinition(theme),
          primary: { ...theme.primary, main: "yellow" },
        },
      });

    await user.upload(document.querySelector<HTMLInputElement>('input[type="file"]')!, invalidFile);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent('broken.json: primary.main (Main): "yellow" is not a valid color. Use #RRGGBB or #RRGGBBAA.');
    expect(alert.closest('[data-testid="responsive-form-dialog-desktop-actions"]')).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Main" })).toHaveValue(theme.primary.main);
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await user.upload(document.querySelector<HTMLInputElement>('input[type="file"]')!, invalidFile);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    const validFile = new File([], "fixed.json", { type: "application/json" });
    validFile.text = async () => JSON.stringify({ version: 1, definition: { ...editableDefinition(theme), name: "Fixed theme" } });
    await user.upload(document.querySelector<HTMLInputElement>('input[type="file"]')!, validFile);
    expect(await screen.findByDisplayValue("Fixed theme")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("saves a personal copy under a distinct name without updating the original", async () => {
    const user = userEvent.setup();
    const personalTheme = { ...theme, id: "personal-id", name: "Personal" };
    const original = { id: personalTheme.id, scope: "user" as const, version: 2, definition: editableDefinition(personalTheme) };
    const existingCopy = { ...original, id: "previous-copy", definition: { ...original.definition, name: "Personal (copy)" } };
    const create = vi.spyOn(api, "createTheme").mockResolvedValue({ ...original, id: "new-copy", version: 1 });
    const update = vi.spyOn(api, "updateTheme");
    const onSaved = vi.fn().mockResolvedValue(undefined);
    render(
      <ThemeEditorDialog
        theme={personalTheme}
        stored={original}
        storedThemes={[original, existingCopy]}
        isAdmin={false}
        onClose={vi.fn()}
        onSaved={onSaved}
      />
    );

    expect(screen.queryByRole("combobox", { name: "Storage" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save copy" }));
    expect(screen.queryByRole("menuitem", { name: "Site themes" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "Your themes" }));
    expect(update).not.toHaveBeenCalled();
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: "Personal (copy 2)" }), "user"));
    expect(onSaved).toHaveBeenCalledWith("new-copy", true);
  });

  it("lets an administrator choose the copy group without changing Save's target", async () => {
    const user = userEvent.setup();
    const siteTheme = { ...theme, id: "site-id", name: "Site theme" };
    const stored = { id: siteTheme.id, scope: "site" as const, version: 2, definition: editableDefinition(siteTheme) };
    const create = vi.spyOn(api, "createTheme").mockResolvedValue({ ...stored, id: "personal-copy", scope: "user" });
    const update = vi.spyOn(api, "updateTheme");
    render(
      <ThemeEditorDialog
        theme={siteTheme}
        stored={stored}
        storedThemes={[stored]}
        isAdmin
        onClose={vi.fn()}
        onSaved={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(screen.queryByRole("combobox", { name: "Storage" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    await chooseCopyDestination(user);

    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: "Site theme" }), "user"));
    expect(update).not.toHaveBeenCalled();
  });

  it("offers site storage only to admins and closes the copy menu on Escape", async () => {
    const user = userEvent.setup();
    const create = vi.spyOn(api, "createTheme").mockResolvedValue({ id: "site-copy", scope: "site", version: 1, definition: theme });
    render(
      <ThemeEditorDialog
        theme={theme}
        stored={undefined}
        storedThemes={[]}
        isAdmin
        onClose={vi.fn()}
        onSaved={vi.fn().mockResolvedValue(undefined)}
      />
    );

    const button = screen.getByRole("button", { name: "Save copy" });
    await user.click(button);
    expect(screen.getByRole("menuitem", { name: "Site themes" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menuitem", { name: "Site themes" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: `Edit ${theme.name} (built-in)` })).toBeInTheDocument();
    await waitFor(() => expect(button).toHaveFocus());
    await chooseCopyDestination(user, "Site themes");

    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: theme.name }), "site"));
  });

  it("retains an automatically renamed draft after a copy request fails", async () => {
    const user = userEvent.setup();
    const existing = { id: "existing-id", scope: "user" as const, version: 2, definition: editableDefinition(theme) };
    vi.spyOn(api, "createTheme").mockRejectedValueOnce(new Error("Theme changed in another tab. Refresh and try again"));
    render(
      <ThemeEditorDialog theme={theme} stored={undefined} storedThemes={[existing]} isAdmin={false} onClose={vi.fn()} onSaved={vi.fn()} />
    );

    await chooseCopyDestination(user);
    expect(await screen.findByText("Theme changed in another tab. Refresh and try again")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(`${theme.name} (copy)`);
  });
});
