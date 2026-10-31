---
name: docs-update
description: Guide for updating website documentation. Use this when asked to update documentation/docs.
---

When asked to update documentation, docs, website docs (interchangeable terms):

Documentation structure:

- The documentation is located in `website/content/docs/<version>`.
- Documentation of the docs system itself is located in the subdirectory `website-dev-guide`.
- The docs system is version-aware and uses content inheritance.
  - Always edit content at the earliest applicable version and use inheritance to propagate changes to later versions as much as possible.
  - The earliest applicable version is the one where a change was introduced.
    - If you're unsure which version that is, ask the user.
  - If a docs change needs to be applied to a page that is currently inherited, copy the page to the applicable version and edit the copy.
  - If the change is a general improvement that applies to all versions, edit the content in the earliest version (e.g., 0.7) and let it inherit to later versions.

Tooling:

- Use the docs editor tool for all docs page/section/book changes: `website/content/docs/website-dev-guide/authoring-and-tooling/docs-editor-tool/`

Style:

- Before editing, read the resolved Docs Style Guide for the target version. Its base source is `website/content/docs/0.7/website-dev-guide/authoring-and-tooling/docs-style-guide/index.md`; later versions can inherit it or override it.
- For user guide changes, apply its **User Guide: Value Without Unnecessary Detail** rules and content test. Do not turn obvious interface actions into tutorials or retain unnecessary technical detail in Reference.
- Before completing user guide changes, perform the style guide's **Author and AI Review** check. Keep task-critical limits and recovery actions.

Docs update process:

- Review the existing documentation to understand its structure and content.
- Focus on the big picture. Don't sprinkle isolated edits.
- Fix what's broken, but also improve what is already working:
  - If you find a section that is confusing, consider rewriting it for better clarity.
  - If you find outdated information, update it to reflect the current state of the project.
  - If you find missing information, add it in a way that fits with the existing content and structure.
  - If you find duplicate information, consolidate it to avoid redundancy.
  - If you find broken links, fix them.
  - If you find formatting issues, correct them.
- After making edits, review the changes to ensure they are accurate and improve the documentation.
