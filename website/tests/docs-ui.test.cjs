const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const website = path.resolve(__dirname, '..');
const template = fs.readFileSync(path.join(website, 'themes/sambee/layouts/partials/search-modal.html'), 'utf8');
const main = fs.readFileSync(path.join(website, 'themes/sambee/assets/js/main.js'), 'utf8');

test('search breadcrumbs include the book for stable, versioned, and full URLs', () => {
  const context = {
    URL,
    window: { location: { origin: 'http://localhost:1313' } },
    docsSearchConfig: { currentVersion: '2.0' },
    docsPathData: { versions: [
      { slug: '2.0', books: {
        'user-guide': { title: 'User Guide', sections: { reference: 'Reference' } },
        'admin-guide': { title: 'Admin Guide', sections: {} },
      } },
      { slug: '0.7', books: { 'user-guide': { title: 'User Guide', sections: { overview: 'Overview' } } } },
    ] },
  };
  vm.createContext(context);
  vm.runInContext(template.slice(template.indexOf('  function getSearchResultPath('), template.indexOf('  // Toggle the magnifier')), context);

  for (const url of [
    '/docs/user-guide/reference/example/',
    '/docs/2.0/user-guide/reference/example/',
    'https://sambee.net/docs/user-guide/reference/example/?query=test#heading',
  ]) {
    assert.equal(context.getSearchResultPath(url), 'User Guide > Reference');
  }
  assert.equal(context.getSearchResultPath('/docs/0.7/user-guide/overview/example/'), 'User Guide > Overview');
  assert.equal(context.getSearchResultPath('/docs/admin-guide/'), 'Admin Guide');
  assert.equal(context.getSearchResultPath('/docs/'), 'Documentation');
  assert.equal(context.getSearchResultPath('/'), 'Home');
  assert.equal(context.getSearchResultPath('/news/'), '');
  assert.equal(context.getSearchResultPath('http://['), '');
});

test('unavailable search gives local recovery steps and can retry initialization', async () => {
  const messages = [];
  const errors = [];
  let attempts = 0;
  const index = { init: async () => { if (++attempts === 1) throw new Error('incomplete index'); } };
  const context = {
    pagefind: null,
    loadIndex: async () => index,
    showEmptyState: message => messages.push(message),
    console: { error: (...args) => errors.push(args) },
  };
  vm.createContext(context);
  const source = template.slice(template.indexOf('  async function loadPagefind()'), template.indexOf('  // Perform search'))
    .replace("import('/pagefind/pagefind.js')", 'loadIndex()');
  vm.runInContext(source, context);

  assert.equal(await context.loadPagefind(), null);
  assert.equal(context.pagefind, null);
  assert.match(messages[0], /npm run dev:with-search/);
  assert.match(messages[0], /npm run dev:search/);
  assert.equal(errors.length, 1);
  assert.equal(await context.loadPagefind(), index);
  assert.equal(attempts, 2);
});

test('version menus focus the current option, navigate, and restore focus', () => {
  const context = {
    DOCS_VERSION_DROPDOWN_SELECTOR: '.docs-sidebar-version-control',
    DOCS_VERSION_DROPDOWN_CLOSE_SELECTOR: '[data-close-version-dropdown]',
    DOCS_VERSION_OPTION_SELECTOR: '.docs-sidebar-version-option',
  };
  const documentEvents = new Map();
  const dropdownEvents = new Map();
  const document = {
    activeElement: null,
    querySelectorAll: (selector) => selector === context.DOCS_VERSION_DROPDOWN_SELECTOR ? [dropdown] : [options[1]],
    addEventListener: (name, handler) => documentEvents.set(name, handler),
  };
  const trigger = { focus: () => { document.activeElement = trigger; } };
  const options = Array.from({ length: 3 }, () => ({
    focus() { document.activeElement = this; },
    closest: () => dropdown,
    addEventListener(name, handler) { this[name] = handler; },
  }));
  const dropdown = {
    open: false,
    contains: (target) => target === trigger || options.includes(target),
    querySelector: (selector) => selector === 'summary' ? trigger : options[1],
    querySelectorAll: () => options,
    addEventListener: (name, handler) => dropdownEvents.set(name, handler),
  };
  context.document = document;
  vm.createContext(context);
  vm.runInContext(main.slice(main.indexOf('    function initDocsVersionDropdowns()'), main.indexOf('   function initDocsSidebarToggles()')), context);
  context.initDocsVersionDropdowns();

  dropdown.open = true;
  dropdownEvents.get('toggle')();
  assert.equal(document.activeElement, options[1]);

  function press(key) {
    let prevented = false;
    dropdownEvents.get('keydown')({ key, preventDefault: () => { prevented = true; } });
    assert.ok(prevented, `${key} should prevent page scrolling or default dismissal`);
  }
  press('ArrowDown');
  assert.equal(document.activeElement, options[2]);
  press('ArrowDown');
  assert.equal(document.activeElement, options[0]);
  press('ArrowUp');
  assert.equal(document.activeElement, options[2]);
  press('Home');
  assert.equal(document.activeElement, options[0]);
  press('End');
  assert.equal(document.activeElement, options[2]);
  press('Escape');
  assert.equal(dropdown.open, false);
  assert.equal(document.activeElement, trigger);

  dropdown.open = true;
  dropdownEvents.get('toggle')();
  options[1].click();
  assert.equal(dropdown.open, false);
  assert.equal(document.activeElement, trigger);

  dropdown.open = true;
  const outside = { focus() { document.activeElement = this; } };
  outside.focus();
  documentEvents.get('click')({ target: outside });
  assert.equal(dropdown.open, false);
  assert.equal(document.activeElement, outside);
});
