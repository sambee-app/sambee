+++
title = "Docs Style Guide"
+++

Use this page as the canonical copy style reference for published docs.

## Language and Writing Style

- Clarity and readability are paramount.
- Use simple but correct language.
- Don't be nitpicky or wordy.
- Use contracted instead of expanded forms, e.g. `we're` instead of `we are`.
- Explain (as appropriate) the following:
  - why things are the way they are
  - how to use things
  - when to use things

## User Guide: Value Without Unnecessary Detail

The user guide must show what Sambee helps users do, then explain only what they need to complete those tasks. It is not a tutorial on familiar browser, file manager, or editor controls.

### Content Test

Keep a passage only if it does at least one of the following:

- Explains a concrete benefit or defines a relevant Sambee concept.
- Explains a non-obvious Sambee action or behavior.
- States a limit or requirement that affects the task.
- Gives an actionable recovery step.

Otherwise, remove it. Moving unnecessary detail to Reference does not make it useful. Administrator policy and implementation details belong in the appropriate guide, not in user task instructions.

### Detail and Page Boundaries

- Do not explain obvious actions such as opening a website, scrolling, typing, or using a clearly labeled standard button. Explain a control only when its behavior differs from what users expect.
- Prefer a short explanation to a numbered procedure when the interface makes the sequence clear. Use steps for non-obvious workflows where order matters.
- Keep small related topics together under clear headings. Create a separate page only when the topic has enough distinct user value or non-obvious behavior to need one.
- Link to existing procedures and in-app help instead of repeating control lists or shortcut tables. Mention a shortcut when it helps with the specific task.
- Keep important limits and data-safety warnings beside the relevant action. Explain each warning once and link to shared recovery guidance where needed.

For example, explain that selecting a file differs from opening it, that desktop edits require an explicit upload, and that a cancelled transfer can leave partial results. Do not describe standard zoom, scrolling, or text entry.

### Product Introduction

Keep **What Is Sambee?** as the user guide's definition page. Start with a short, standalone definition and concrete benefits. State device and Companion requirements briefly; do not turn the introduction into an architecture explanation. The guide landing page links to this definition rather than repeating it.

### Author and AI Review

Apply the content test before adding or expanding user guide content. Before completing a change, remove obvious instructions, duplicate explanations, unnecessary technical detail, and pages that should be short subsections. Verify that important limits and recovery actions remain clear. Brevity must not remove information needed to avoid data loss or complete a task safely.

## Lists

### Sentence Style

Use one list style per list. Do not mix sentence bullets and fragment bullets.

- Sentence lists use complete sentences.
   - Sentence bullets start with a capital letter and end with a full stop.
   - After a colon, capitalize the next word when what follows is a sentence.
- Fragment lists use short labels, file names, commands, paths, shortcuts, or other bare literals.
   - Fragment bullets preserve literal casing and usually do not take a full stop.
   - Prefer short, parallel labels for control or feature lists, for example `Zoom`, `Pan`, `Rotate`.
   - If a fragment needs explanation, rewrite it as a sentence bullet or use a table.

Preferred sentence list:

```markdown
- Focus matters: Shortcuts act on the item that currently has focus.
- The active pane matters: In dual-pane mode, many browser commands target the currently active pane.
- Important actions stay discoverable: The same actions are also available through visible controls and the in-app shortcuts help.
```

Valid fragment list:

```markdown
- `config.toml`
- `website/content/docs/`
- `Ctrl` + `K`
```

### List Structure

- Make use of multiple hierarchies to structure content.
- Mixing ordered and unordered lists is allowed.

### Ordered Lists

- Don't number ordered lists consecutively, use `1.` for all items. Let the Markdown renderer do the numbering.

## Headings

- Use multiple heading levels to logically group and structure content. Don't limit yourself to h2.

## More Information

See [Docs Authoring Workflow](../docs-authoring-workflow/) for where copy edits fit into the docs workflow, and [Docs Editor Tool](../docs-editor-tool/) for structural docs changes.
