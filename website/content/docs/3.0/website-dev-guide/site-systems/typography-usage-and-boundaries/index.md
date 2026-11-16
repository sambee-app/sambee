+++
title = "Typography Usage and Boundaries"
+++

This page covers the applied side of the website typography system.

Use it when you need examples, implementation patterns, or boundary rules for deciding whether typography belongs in a shared utility or in component-local CSS.

## Representative Definitions

Representative implementations from `website/themes/sambee/assets/css/shared.css`:

```css
@utility type-copy {
  font-family: var(--font-primary);
  font-size: var(--text-copy);
  font-weight: 400;
  font-style: normal;
  letter-spacing: normal;
  line-height: var(--leading-copy);
}

@utility type-label-sm {
  font-family: var(--font-tertiary);
  font-size: var(--text-label-sm);
  font-weight: 400;
  font-style: normal;
  text-transform: uppercase;
  letter-spacing: var(--tracking-label);
}

@utility type-docs-nav {
  font-family: var(--font-primary);
  font-size: var(--text-docs-nav);
  font-weight: 400;
  font-style: normal;
  letter-spacing: normal;
  line-height: var(--leading-docs-nav);
}

@utility type-title-md {
  font-family: var(--font-secondary);
  font-size: var(--text-title-md);
  font-weight: 700;
  font-style: normal;
  letter-spacing: normal;
  line-height: var(--leading-title-md);
}
```

## Template Usage Rules

Templates should apply one semantic typography utility per text role and then combine it with separate classes for color, layout, and interaction state.

Examples from the live theme:

```html
<span class="type-label-eyebrow type-color-accent eyebrow-stack">Documentation</span>
<h2 class="type-section-title type-color-ink">Fast local-first preview</h2>
<span class="docs-sidebar-link docs-sidebar-link-current type-docs-nav type-color-ink ui-current-primary-inset">Current page</span>
<a class="docs-sidebar-link type-docs-nav type-color-muted ui-transition-color type-hover-ink ui-hover-surface-mid" href="/docs/">Documentation</a>
```

Current usage rules:

- Apply one semantic `type-*` utility per text element.
- Combine that utility with color helpers, layout helpers, and component-specific state classes as needed.
- Do not stack two `type-*` utilities that both set size, weight, letter-spacing, line-height, or text transform.
- Do not reintroduce a partial base class such as `type-label`.

Patterns intentionally absent from the current theme include:

```html
<span class="type-label type-label-strong">...</span>
<span class="type-label type-label-xs">...</span>
<li class="type-label type-list-item-label">...</li>
```

## Local Typography Boundaries

Not every text treatment is shared.

### Docs UI

`website/themes/sambee/assets/css/docs.css` uses the shared `type-docs-nav` role for repeated documentation navigation text, including:

- table of contents links
- version switcher labels and options
- nav tree links and current items
- sequential navigation labels and titles

Local docs classes still own padding, indentation, and current-item state. For example, `.docs-sidebar-link-current` adds the stronger weight for the active item instead of relying on a separate semantic utility.

### Navigation

`website/themes/sambee/assets/css/navigation.css` keeps `.nav-link` as a component-local role. It consumes shared tracking values so the navigation remains aligned with the site-wide label scale.

### Buttons

`website/themes/sambee/assets/css/buttons.css` keeps `.btn` and `.btn-sm` as local button primitives. They consume shared typography tokens where it makes sense, but buttons are not modeled as shared text-role utilities.

### Footer

Footer layout classes remain local in `website/themes/sambee/assets/css/footer.css`. Shared typography utilities (`type-docs-nav` and `type-label-eyebrow`) supply the text roles for copyright copy, comparison links, and legal links.

### Comparison and Marketing Pages

`website/themes/sambee/assets/css/marketing.css` keeps the non-homepage `H1` page-title scale local to `.marketing-hero-title` (`2.5rem` → `3rem` → `3.4rem`, matching `.docs-main-column` and `.standalone-main`) and disables uppercase transform on `.marketing-code-filename` so file names such as `docker-compose.yml` keep literal casing. All hero, sticky subnav, qualification split, comparison matrix, editorial chapter, visual proof, test-drive, and FAQ partials in `partials/marketing/*` consume shared `type-*` utilities (`type-hero`, `type-section-title`, `type-title-xl`, `type-title-md`, `type-title-md-tight`, `type-label-eyebrow`, `type-label-eyebrow-strong`, `type-label-strong`, `type-label-sm`, `type-label-xs`, and `type-copy`) with one semantic utility per element.

### Content-Specific Typography

Article-content semantics such as table headers, `figcaption`, `dt`, and admonition titles remain local to `content.css`. They belong to the content domain, not to shared site-wide text roles.
