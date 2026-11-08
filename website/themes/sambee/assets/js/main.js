/* Purpose: Provides a shared entry point for lightweight site-wide JavaScript. */
(function () {
   "use strict";

   const COPY_BUTTON_SELECTOR = '.content pre, .content .highlight';
   const COPY_BUTTON_CLASS = 'code-copy-btn';
   const DOCS_VERSION_DROPDOWN_SELECTOR = '.docs-sidebar-version-control';
   const DOCS_VERSION_DROPDOWN_CLOSE_SELECTOR = '[data-close-version-dropdown]';
   const DOCS_VERSION_OPTION_SELECTOR = '.docs-sidebar-version-option';
   const DOCS_SIDEBAR_TOGGLE_SELECTOR = '.docs-sidebar-toggle';
   const DOCS_SECTION_TRIGGER_SELECTOR = '[data-docs-section-trigger="true"]';
   const DOCS_PAGE_SELECTOR = '.docs-shell--page';
   const DOCS_ARTICLE_REGION_SELECTOR = '.article-toc-container';
   const DOCS_TOC_SIDEBAR_SELECTOR = '.docs-toc-sidebar';
   const DOCS_TOC_SELECTOR = '.docs-toc';
   const DOCS_TOC_INNER_SELECTOR = '.docs-toc-inner';
   const PROMOTION_OVERVIEW_SELECTOR = '[data-companion-promotion-overview]';
   const PROMOTION_OVERVIEW_SCHEMA_VERSION = 1;
   const PROMOTION_OVERVIEW_TIMEOUT_MS = 10000;
   const PROMOTION_TARGETS = [
      { key: 'stable', label: 'Companion stable' },
      { key: 'beta', label: 'Companion beta' },
      { key: 'test', label: 'Companion test' },
      { key: 'sambee', label: 'Sambee downloads' }
   ];
     const KBD_SELECTOR = 'kbd';
   const COPY_FEEDBACK_TIMEOUT_MS = 1600;
     const KBD_ARIA_LABELS = {
        '↑': 'Up Arrow',
        '↓': 'Down Arrow',
        '←': 'Left Arrow',
        '→': 'Right Arrow',
        '↵': 'Enter',
        '⏎': 'Enter',
        '⌘': 'Command',
        '⌥': 'Option',
        '⌫': 'Backspace',
        '⌦': 'Delete',
        '⇧': 'Shift',
        '⇥': 'Tab',
        '⇪': 'Caps Lock',
        esc: 'Escape',
        ctrl: 'Control',
        del: 'Delete',
        ins: 'Insert',
        pgup: 'Page Up',
        pgdn: 'Page Down',
        cmd: 'Command',
        alt: 'Alt',
        opt: 'Option'
     };

   function getCopyIconMarkup(iconName, label) {
      return '<span class="material-symbols-outlined" aria-hidden="true">' + iconName + '</span><span class="visually-hidden">' + label + '</span>';
   }

   function createCopyButton() {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = COPY_BUTTON_CLASS;
      button.setAttribute('aria-label', 'Copy code');
      button.innerHTML = '<span class="icon-copy">' + getCopyIconMarkup('content_copy', 'Copy code') + '</span><span class="icon-check">' + getCopyIconMarkup('check', 'Copied') + '</span>';
      return button;
   }

   function getCodeText(codeElement) {
      if (!codeElement) {
         return '';
      }

      const chromaLines = codeElement.querySelectorAll('.cl');

      if (chromaLines.length) {
         return Array.from(chromaLines, (line) => line.textContent || '').join('').replace(/\n$/, '');
      }

      return (codeElement.textContent || '').replace(/\n$/, '');
   }

   async function copyCode(button, codeElement) {
      const code = getCodeText(codeElement);

      if (!code) {
         return;
      }

      try {
         await navigator.clipboard.writeText(code);
         button.classList.add('copied');
         window.setTimeout(() => button.classList.remove('copied'), COPY_FEEDBACK_TIMEOUT_MS);
      } catch (_error) {
         button.classList.remove('copied');
      }
   }

   function initCodeCopyButtons() {
      document.querySelectorAll(COPY_BUTTON_SELECTOR).forEach((block) => {
         if (block.tagName === 'PRE' && block.parentElement && block.parentElement.classList.contains('highlight')) {
            return;
         }

         if (block.querySelector('.' + COPY_BUTTON_CLASS)) {
            return;
         }

         const codeElement = block.querySelector('code') || block;
         const button = createCopyButton();
         button.addEventListener('click', () => copyCode(button, codeElement));
         block.appendChild(button);
      });
   }

     function getKbdAriaLabel(text) {
        const normalizedText = (text || '').trim();

        if (!normalizedText) {
           return '';
        }

        const mapped = KBD_ARIA_LABELS[normalizedText] || KBD_ARIA_LABELS[normalizedText.toLowerCase()];

        if (mapped) {
           return mapped;
        }

        if (/^f\d{1,2}$/i.test(normalizedText)) {
           return normalizedText.toUpperCase();
        }

        if (normalizedText.length === 1 && /[a-z]/i.test(normalizedText)) {
           return normalizedText.toUpperCase();
        }

        return normalizedText;
     }

     function initKeyboardAriaLabels() {
        document.querySelectorAll(KBD_SELECTOR).forEach((element) => {
           if (element.hasAttribute('aria-label')) {
              return;
           }

           const label = getKbdAriaLabel(element.textContent);

           if (label) {
              element.setAttribute('aria-label', label);
           }
        });
     }

    function initDocsVersionDropdowns() {
      const dropdowns = document.querySelectorAll(DOCS_VERSION_DROPDOWN_SELECTOR);

      if (!dropdowns.length) {
         return;
      }

      dropdowns.forEach((dropdown) => {
         const trigger = dropdown.querySelector('summary');
         const options = Array.from(dropdown.querySelectorAll(DOCS_VERSION_OPTION_SELECTOR));

         dropdown.addEventListener('toggle', () => {
            if (dropdown.open) {
               const currentOption = dropdown.querySelector('[aria-current="true"]');
               (currentOption || options[0])?.focus();
            }
         });

         dropdown.addEventListener('keydown', (event) => {
            if (!dropdown.open || !options.length) {
               return;
            }

            const currentIndex = options.indexOf(document.activeElement);
            let nextIndex;
            switch (event.key) {
               case 'ArrowDown':
                  nextIndex = (currentIndex + 1) % options.length;
                  break;
               case 'ArrowUp':
                  nextIndex = (currentIndex - 1 + options.length) % options.length;
                  break;
               case 'Home':
                  nextIndex = 0;
                  break;
               case 'End':
                  nextIndex = options.length - 1;
                  break;
               case 'Escape':
                  event.preventDefault();
                  dropdown.open = false;
                  trigger?.focus();
                  return;
               default:
                  return;
            }

            event.preventDefault();
            options[nextIndex].focus();
         });
      });

      document.querySelectorAll(DOCS_VERSION_DROPDOWN_CLOSE_SELECTOR).forEach((button) => {
         button.addEventListener('click', () => {
            const dropdown = button.closest(DOCS_VERSION_DROPDOWN_SELECTOR);

            if (dropdown) {
               dropdown.open = false;
               dropdown.querySelector('summary')?.focus();
            }
         });
      });

      document.addEventListener('click', (event) => {
         dropdowns.forEach((dropdown) => {
            if (dropdown.open && !dropdown.contains(event.target)) {
               dropdown.open = false;
            }
         });
      });

      document.addEventListener('keydown', (event) => {
         if (event.key !== 'Escape') {
            return;
         }

         dropdowns.forEach((dropdown) => {
            if (dropdown.open) {
               dropdown.open = false;
            }
         });
      });
   }

   function initDocsSidebarToggles() {
      function syncDocsSidebarControls(control, targetId, isExpanded) {
         const row = control.closest('.docs-nav-group-row, .docs-sidebar-title-row');

         if (!row) {
            control.setAttribute('aria-expanded', String(isExpanded));
            return;
         }

         row.querySelectorAll('[aria-controls="' + targetId + '"]').forEach((element) => {
            element.setAttribute('aria-expanded', String(isExpanded));
         });
      }

      function toggleDocsSidebarContainer(control) {
         const targetId = control.getAttribute('aria-controls');

         if (!targetId) {
            return;
         }

         const container = document.getElementById(targetId);

         if (!container) {
            return;
         }

         const nextExpandedState = control.getAttribute('aria-expanded') !== 'true';
         syncDocsSidebarControls(control, targetId, nextExpandedState);
         container.hidden = !nextExpandedState;
      }

      document.querySelectorAll(DOCS_SIDEBAR_TOGGLE_SELECTOR).forEach((button) => {
         button.addEventListener('click', () => {
            toggleDocsSidebarContainer(button);
         });
      });

      document.querySelectorAll(DOCS_SECTION_TRIGGER_SELECTOR).forEach((trigger) => {
         trigger.addEventListener('click', (event) => {
            if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
               return;
            }

            toggleDocsSidebarContainer(trigger);
         });

         if (trigger.getAttribute('role') === 'button') {
            trigger.addEventListener('keydown', (event) => {
               if (event.key !== 'Enter' && event.key !== ' ') {
                  return;
               }

               event.preventDefault();
               toggleDocsSidebarContainer(trigger);
            });
         }
      });
   }

   function updateDocsTocStickyOffsets() {
      document.querySelectorAll(DOCS_PAGE_SELECTOR).forEach((pageShell) => {
         const tocSidebar = pageShell.querySelector(DOCS_TOC_SIDEBAR_SELECTOR);

         if (!tocSidebar) {
            pageShell.style.removeProperty('--docs-toc-content-top');
            return;
         }

         const tocContent = tocSidebar.querySelector(DOCS_TOC_INNER_SELECTOR) || tocSidebar.querySelector(DOCS_TOC_SELECTOR) || tocSidebar;
         const contentTop = Math.max(0, tocContent.getBoundingClientRect().top);

         pageShell.style.setProperty('--docs-toc-content-top', `${contentTop}px`);
      });
   }

   function initDocsTocScrollSpy() {
      const toc = document.querySelector(DOCS_TOC_SELECTOR);

      if (!toc) {
         return;
      }

      const tocLinks = toc.querySelectorAll('a[href^="#"]');

      if (!tocLinks.length) {
         return;
      }

      const headingIds = Array.from(tocLinks)
         .map((link) => link.getAttribute('href'))
         .filter(Boolean)
         .map((href) => href.substring(1));

      const headings = headingIds
         .map((id) => document.getElementById(decodeURIComponent(id)))
         .filter(Boolean);

      if (!headings.length) {
         return;
      }

      const linkById = new Map(
         Array.from(tocLinks).map((link) => [decodeURIComponent((link.getAttribute('href') || '').substring(1)), link])
      );

      let currentActiveLink = null;
      let hashNavigationPending = false;
      let animationFramePending = false;

      function setActiveLink(link) {
         if (!link || link === currentActiveLink) {
            return;
         }

         if (currentActiveLink) {
            currentActiveLink.classList.remove('toc-active');
         }

         link.classList.add('toc-active');
         currentActiveLink = link;
      }

      function updateActiveLink() {
         if (animationFramePending) {
            return;
         }

         animationFramePending = true;

         requestAnimationFrame(() => {
            animationFramePending = false;

            if (hashNavigationPending) {
               return;
            }

            const stickyTopValue = getComputedStyle(document.querySelector(DOCS_PAGE_SELECTOR) || document.documentElement)
               .getPropertyValue('--docs-toc-content-top')
               .trim();
            const threshold = Number.parseFloat(stickyTopValue) || 120;

            let targetHeading = headings[0];

            for (const heading of headings) {
               if (heading.getBoundingClientRect().top <= threshold) {
                  targetHeading = heading;
               } else {
                  break;
               }
            }

            if (!targetHeading) {
               return;
            }

            const targetLink = linkById.get(targetHeading.id);

            setActiveLink(targetLink);
         });
      }

      function handleHashNavigation() {
         const hash = window.location.hash;

         if (!hash) {
            updateActiveLink();
            return;
         }

         const targetLink = linkById.get(decodeURIComponent(hash.substring(1)));

         if (!targetLink) {
            updateActiveLink();
            return;
         }

         hashNavigationPending = true;
         setActiveLink(targetLink);

         window.setTimeout(() => {
            hashNavigationPending = false;
            updateActiveLink();
         }, 500);
      }

      window.addEventListener('scroll', updateActiveLink, { passive: true });
      window.addEventListener('hashchange', handleHashNavigation);
   window.addEventListener('resize', updateActiveLink);

      updateActiveLink();
      window.setTimeout(handleHashNavigation, 100);
   }

   function isRecord(value) {
      return typeof value === 'object' && value !== null && !Array.isArray(value);
   }

   function parsePromotionRows(payload) {
      if (!isRecord(payload) || payload.schema_version !== PROMOTION_OVERVIEW_SCHEMA_VERSION || !isRecord(payload.channels)) {
         throw new Error('Promotion index has an unsupported format.');
      }

      const rows = [];
      PROMOTION_TARGETS.forEach((target) => {
         const promotion = payload.channels[target.key];

         if (promotion === undefined) {
            return;
         }
         if (!isRecord(promotion) || typeof promotion.version !== 'string' || !promotion.version.trim()) {
            throw new Error('Promotion index contains an invalid target.');
         }
         if (promotion.published_at !== undefined && (typeof promotion.published_at !== 'string' || !promotion.published_at.trim())) {
            throw new Error('Promotion index contains an invalid release date.');
         }

         rows.push({
            label: target.label,
            version: promotion.version.trim(),
            publishedAt: typeof promotion.published_at === 'string' ? promotion.published_at.trim() : 'Not provided'
         });
      });

      if (!rows.length) {
         throw new Error('Promotion index does not contain any current targets.');
      }

      return rows;
   }

   function renderPromotionRows(tableBody, rows) {
      const fragment = document.createDocumentFragment();

      rows.forEach((row) => {
         const tableRow = document.createElement('tr');

         [row.label, row.version, row.publishedAt].forEach((value) => {
            const cell = document.createElement('td');
            cell.textContent = value;
            tableRow.appendChild(cell);
         });

         fragment.appendChild(tableRow);
      });

      tableBody.replaceChildren(fragment);
   }

   async function loadPromotionOverview(overview) {
      const feedUrl = overview.getAttribute('data-feed-url');
      const status = overview.querySelector('[data-companion-promotion-status]');
      const table = overview.querySelector('[data-companion-promotion-table]');
      const tableBody = overview.querySelector('[data-companion-promotion-rows]');

      if (!feedUrl || !status || !table || !tableBody) {
         return;
      }

      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), PROMOTION_OVERVIEW_TIMEOUT_MS);

      try {
         const response = await fetch(feedUrl, { signal: controller.signal });
         if (!response.ok) {
            throw new Error('Promotion index request failed.');
         }

         renderPromotionRows(tableBody, parsePromotionRows(await response.json()));
         status.hidden = true;
         table.hidden = false;
      } catch (_error) {
         status.textContent = 'Current promotion data is temporarily unavailable. Use the raw promotion index instead.';
      } finally {
         window.clearTimeout(timeoutId);
      }
   }

   function initPromotionOverviews() {
      document.querySelectorAll(PROMOTION_OVERVIEW_SELECTOR).forEach((overview) => {
         void loadPromotionOverview(overview);
      });
   }

   function init() {
      initCodeCopyButtons();
      initDocsVersionDropdowns();
      initDocsSidebarToggles();
      updateDocsTocStickyOffsets();
      initDocsTocScrollSpy();
      initPromotionOverviews();

      window.addEventListener('resize', updateDocsTocStickyOffsets);
   }

   if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
        document.addEventListener('DOMContentLoaded', initKeyboardAriaLabels);
   } else {
      init();
        initKeyboardAriaLabels();
   }
})();
