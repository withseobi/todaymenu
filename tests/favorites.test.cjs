const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
const menu = JSON.parse(fs.readFileSync(path.join(root, 'menu.json'), 'utf8'));
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(setImmediate); };

class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.handlers = {};
    this.attributes = {};
    this.dataset = {};
    this.value = '';
    this.hidden = false;
    this.open = false;
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return (this.text || '') + this.children.map(child => typeof child === 'string' ? child : child.textContent).join(''); }
  get childElementCount() { return this.children.filter(child => typeof child !== 'string').length; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.text = ''; this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, handler) { this.handlers[name] = handler; }
  fire(name) { return this.handlers[name]?.({ preventDefault() {} }); }
  click() { return this.fire('click'); }
  add(option) { this.children.push(option); }
  focus() {}
  reportValidity() { return true; }
  showModal() { this.open = true; }
  close() { this.open = false; this.fire('close'); }
  querySelectorAll(selector) { return this.children.filter(child => child.tagName === selector.toUpperCase()); }
}

function fixture(rows = []) {
  const elements = new Map();
  const el = selector => {
    if (!elements.has(selector)) elements.set(selector, new Element());
    return elements.get(selector);
  };
  const database = { rows: rows.map(row => ({ ...row })), calls: [], failRead: false, failWrite: false, readGate: null, writeGate: null };
  let session = null;
  let authListener;
  const client = {
    auth: {
      onAuthStateChange(fn) { authListener = fn; return { data: {} }; },
      async getSession() { return { data: { session }, error: null }; },
      async signOut() { session = null; authListener('SIGNED_OUT', null); return { error: null }; }
    },
    from(table) {
      assert.equal(table, 'favorites');
      const query = {
        operation: 'read', filters: {}, payload: null,
        select() { return this; }, order() { return this; }, single() { return this; },
        eq(key, value) { this.filters[key] = value; return this; },
        insert(payload) { this.operation = 'insert'; this.payload = payload; return this; },
        delete() { this.operation = 'delete'; return this; },
        then(resolve, reject) {
          const run = async () => {
            const call = { operation: this.operation, filters: { ...this.filters }, payload: this.payload };
            database.calls.push(call);
            if (this.operation === 'read') {
              const rows = database.rows.filter(row => row.user_id === this.filters.user_id).map(row => ({ ...row }));
              if (database.readGate) await database.readGate;
              return database.failRead ? { error: { code: 'NETWORK' } } : { data: rows, error: null };
            }
            if (database.writeGate) await database.writeGate;
            if (database.failWrite) return { error: { code: 'NETWORK' } };
            if (this.operation === 'insert') {
              if (database.rows.some(row => row.user_id === this.payload.user_id && row.recipe_id === this.payload.recipe_id)) return { error: { code: '23505' } };
              database.rows.push({ ...this.payload });
              return { data: this.payload, error: null };
            }
            database.rows = database.rows.filter(row => !(row.user_id === this.filters.user_id && row.recipe_id === this.filters.recipe_id));
            return { data: [], error: null };
          };
          return run().then(resolve, reject);
        }
      };
      return query;
    }
  };
  const context = vm.createContext({
    document: { readyState: 'complete', querySelector: el, createElement: tag => new Element(tag) },
    window: { supabase: { createClient: () => client } },
    fetch: async () => ({ ok: true, json: async () => menu }),
    Option: function (label, value) { this.textContent = label; this.value = value; },
    URL, location: { href: 'http://127.0.0.1:8000/', protocol: 'http:' }, console,
    setTimeout(fn, delay) { if (delay === 0) queueMicrotask(fn); return 1; }, clearTimeout() {}
  });
  scripts.forEach(script => vm.runInContext(script, context));
  return {
    el, database, context,
    run: source => vm.runInContext(source, context),
    login(id) { session = id ? { user: { id, email: `${id}@example.test` } } : null; authListener(id ? 'SIGNED_IN' : 'SIGNED_OUT', session); }
  };
}

test('guest guidance, save/delete and favorites across months', async () => {
  const f = fixture(); await flush();
  f.run('openRecipe(data.recipes.find(recipe => recipe.id === 36))');
  await f.el('#favorite-toggle').click();
  assert.equal(f.el('#favorite-message').textContent, '로그인하면 즐겨찾기를 저장할 수 있어요');
  assert.equal(f.database.calls.length, 0);
  f.login('reader-a'); await flush();
  await f.el('#favorite-toggle').click();
  assert.equal(f.el('#favorite-toggle').textContent, '★');
  assert.equal(f.database.rows[0].user_id, 'reader-a');
  f.database.rows.push({ user_id: 'reader-a', recipe_id: 28 });
  await f.run('loadFavorites()');
  f.el('#favorites-button').click();
  assert.equal(f.el('.hero').hidden, true);
  assert.equal(f.el('#extra-results').hidden, true);
  assert.equal(f.el('#recipes').childElementCount, 2);
  assert(f.el('#recipes').textContent.includes('새우 두부 계란찜'));
  await f.el('#favorite-toggle').click();
  assert.equal(f.el('#favorite-toggle').textContent, '☆');
  assert.equal(f.el('#recipes').childElementCount, 1);
  const deletion = f.database.calls.find(call => call.operation === 'delete');
  assert.equal(deletion.filters.user_id, 'reader-a');
  assert.equal(deletion.filters.recipe_id, 36);
  f.login(null); await flush();
  assert.equal(f.run('favoriteIds.size'), 0);
  assert(f.el('#recipes').textContent.includes('로그인하면 즐겨찾기를 저장할 수 있어요'));
});

test('failed writes preserve the last saved state and permit retry', async () => {
  const f = fixture(); await flush(); f.login('reader-a'); await flush();
  f.run('openRecipe(data.recipes.find(recipe => recipe.id === 36))');
  f.database.failWrite = true;
  await f.el('#favorite-toggle').click();
  assert.equal(f.el('#favorite-toggle').textContent, '☆');
  assert.equal(f.el('#favorite-message').dataset.kind, 'error');
  f.database.failWrite = false;
  await f.el('#favorite-toggle').click();
  f.database.failWrite = true;
  await f.el('#favorite-toggle').click();
  assert.equal(f.el('#favorite-toggle').textContent, '★');
  assert.equal(f.el('#favorite-toggle').disabled, false);
});

test('duplicate saves converge to the saved state', async () => {
  const f = fixture(); await flush(); f.login('reader-a'); await flush();
  f.run('openRecipe(data.recipes.find(recipe => recipe.id === 36))');
  f.database.rows.push({ user_id: 'reader-a', recipe_id: 36 });
  await f.el('#favorite-toggle').click();
  assert.equal(f.el('#favorite-toggle').textContent, '★');
  assert.equal(f.database.rows.length, 1);
});

test('late reads from a previous user cannot leak into the next session', async () => {
  const f = fixture([{ user_id: 'reader-a', recipe_id: 36 }, { user_id: 'reader-b', recipe_id: 28 }]);
  await flush();
  let release;
  f.database.readGate = new Promise(resolve => { release = resolve; });
  f.login('reader-a'); await flush();
  f.database.readGate = null;
  f.login('reader-b'); await flush();
  release(); await flush();
  assert.equal(f.run('favoriteIds.has(36)'), false);
  assert.equal(f.run('favoriteIds.has(28)'), true);
});

test('late writes and double clicks cannot alter the next account display', async () => {
  const f = fixture(); await flush(); f.login('reader-a'); await flush();
  f.run('openRecipe(data.recipes.find(recipe => recipe.id === 36))');
  let release;
  f.database.writeGate = new Promise(resolve => { release = resolve; });
  const saving = f.el('#favorite-toggle').click(); await flush();
  await f.el('#favorite-toggle').click();
  assert.equal(f.database.calls.filter(call => call.operation === 'insert').length, 1);
  f.login('reader-b'); await flush();
  release(); await saving; await flush();
  assert.equal(f.run('favoriteIds.size'), 0);
  assert.equal(f.el('#favorite-toggle').textContent, '☆');
});

test('failed list requests show a retry state instead of an empty list', async () => {
  const f = fixture(); await flush(); f.database.failRead = true;
  f.login('reader-a'); await flush(); f.el('#favorites-button').click(); await flush();
  assert(f.el('#recipes').textContent.includes('즐겨찾기를 불러오지 못했어요'));
  f.database.failRead = false;
  await f.run('loadFavorites()');
  assert(f.el('#recipes').textContent.includes('아직 저장한 메뉴가 없어요'));
});
