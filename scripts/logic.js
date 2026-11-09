/**
 * Pure helper logic with no Foundry dependencies, so it can be tested in Node.
 */

/** Flag names stored under flags["ah-5e-party-stash"]. */
export const FLAGS = Object.freeze({
  STASH_ACTOR: "stashActor",   // The actor that really holds every stash and its items
  STASH: "stash",              // A real stash container on that actor
  DEFAULT: "default",          // Marks the first/main stash (used for old bags that don't say which stash)
  CONFIG: "config",            // A stash's settings: accent colour and tabs
  PROXY: "proxy",              // A stash bag that players carry (a key, holds nothing)
  TEMPLATE: "template",        // The world item in the Items sidebar players drag into their inventory
  STASH_ID: "stashId",         // On a carried bag / sidebar item: which stash it opens
  CATEGORY: "category"         // On an item inside a stash: which tab it belongs to
});

export const DEFAULT_ACCENT = "#4fb3c9";

/** Special tab ids (never used as a real category id). */
export const TAB_ALL = "all";
export const TAB_UNSORTED = "unsorted";

/* -------------------------------------------- */
/*  Drag and drop                               */
/* -------------------------------------------- */

/**
 * Decide the drag/drop behaviour when an item moves between actors.
 * Moving an item out of (or into) the party stash should always MOVE it, never duplicate it.
 */
export function decideDropBehavior({ result, isItem, sourceActorId, targetActorId, stashActorId, isGM, copyKey }) {
  if ( !isItem || !stashActorId ) return result;
  if ( (result === "none") || (result === "link") ) return result;
  if ( !sourceActorId || !targetActorId || (sourceActorId === targetActorId) ) return result;
  const involvesStash = (sourceActorId === stashActorId) || (targetActorId === stashActorId);
  if ( !involvesStash ) return result;
  // GMs may still duplicate on purpose by holding the copy key. Players always move.
  if ( isGM && copyKey ) return "copy";
  return "move";
}

/* -------------------------------------------- */
/*  Weightless bags                             */
/* -------------------------------------------- */

/** Data that keeps a stash bag (real or carried) weightless and unlimited. */
export function weightlessSystemData() {
  return {
    "system.weight.value": 0,
    "system.capacity.count": null,
    "system.capacity.volume.value": null,
    "system.capacity.weight.value": null,
    "system.quantity": 1,
    "system.identified": true
  };
}

/**
 * Given an update to a stash bag, force the weight and capacity back to "weightless and unlimited".
 * Mutates and returns the flattened changes.
 */
export function sanitizeBagChanges(flatChanges) {
  for ( const [key, value] of Object.entries(weightlessSystemData()) ) {
    if ( key in flatChanges ) flatChanges[key] = value;
  }
  if ( flatChanges["system.weight"] && (typeof flatChanges["system.weight"] === "object") ) {
    flatChanges["system.weight"].value = 0;
  }
  if ( flatChanges["system.capacity"] && (typeof flatChanges["system.capacity"] === "object") ) {
    delete flatChanges["system.capacity"];
  }
  for ( const key of Object.keys(flatChanges) ) {
    if ( key.startsWith("system.capacity.") && !(key in weightlessSystemData()) ) delete flatChanges[key];
  }
  const props = flatChanges["system.properties"];
  if ( Array.isArray(props) && !props.includes("weightlessContents") ) props.push("weightlessContents");
  if ( flatChanges["system.properties.-=weightlessContents"] !== undefined ) {
    delete flatChanges["system.properties.-=weightlessContents"];
  }
  return flatChanges;
}

/**
 * Work out which loose items on the stash actor should be put back into a stash
 * (e.g. if a stash bag was deleted without deleting its contents).
 * @param {object[]} items  Plain objects: { id, container, flags, physical }.
 * @param {string} moduleId
 * @returns {string[]}  Item ids that aren't inside any existing container.
 */
export function findLooseItems(items, moduleId) {
  const ids = new Set(items.map(i => i.id));
  return items.filter(i => {
    if ( !i.physical ) return false;
    if ( i.flags?.[moduleId]?.[FLAGS.STASH] ) return false;
    return !i.container || !ids.has(i.container);
  }).map(i => i.id);
}

/* -------------------------------------------- */
/*  Stash settings (tabs, keywords, colour)     */
/* -------------------------------------------- */

/** "a, b ,, c" -> ["a", "b", "c"]. Also accepts an array. Removes duplicates (ignoring case). */
export function parseKeywords(value) {
  const parts = Array.isArray(value) ? value : String(value ?? "").split(",");
  const seen = new Set();
  const out = [];
  for ( let part of parts ) {
    part = String(part ?? "").trim().replace(/^\*+|\*+$/g, "").trim();
    if ( !part ) continue;
    const key = part.toLowerCase();
    if ( seen.has(key) ) continue;
    seen.add(key);
    out.push(part);
  }
  return out;
}

/** Is this a "#rrggbb" colour? */
export function isValidColor(value) {
  return /^#[0-9a-f]{6}$/i.test(String(value ?? ""));
}

/**
 * Clean up a stash's stored settings so the rest of the code can trust them.
 * @param {object} raw
 * @param {() => string} makeId  Makes a new random id for tabs that don't have one.
 * @returns {{accent: string, categories: {id: string, name: string, keywords: string[]}[]}}
 */
export function normalizeConfig(raw, makeId) {
  const accent = isValidColor(raw?.accent) ? raw.accent.toLowerCase() : DEFAULT_ACCENT;
  const categories = [];
  const used = new Set([TAB_ALL, TAB_UNSORTED]);
  for ( const c of (Array.isArray(raw?.categories) ? raw.categories : []) ) {
    const name = String(c?.name ?? "").trim();
    if ( !name ) continue;
    let id = String(c?.id ?? "").trim();
    if ( !id || used.has(id) ) id = makeId();
    used.add(id);
    categories.push({ id, name, keywords: parseKeywords(c?.keywords) });
  }
  return { accent, categories };
}

/**
 * Which tab an item belongs to, given its stored category id.
 * @returns {string|null}  A category id, or null if it's unsorted.
 */
export function resolveCategory(categoryId, categories) {
  if ( !categoryId ) return null;
  return categories.some(c => c.id === categoryId) ? categoryId : null;
}

/** Does an item with this category show on this tab? */
export function showsOnTab(tabId, categoryId, categories) {
  if ( !tabId || (tabId === TAB_ALL) ) return true;
  const cat = resolveCategory(categoryId, categories);
  if ( tabId === TAB_UNSORTED ) return cat === null;
  return cat === tabId;
}

/** Count items per tab. @param {(string|null)[]} itemCategories */
export function countTabs(itemCategories, categories) {
  const counts = { [TAB_ALL]: 0, [TAB_UNSORTED]: 0 };
  for ( const c of categories ) counts[c.id] = 0;
  for ( const raw of itemCategories ) {
    counts[TAB_ALL]++;
    const cat = resolveCategory(raw, categories);
    counts[cat ?? TAB_UNSORTED]++;
  }
  return counts;
}

/**
 * The category to give an item dropped into a stash while a tab is open.
 * @returns {string|null}
 */
export function categoryForDrop(activeTab, categories) {
  if ( !activeTab || (activeTab === TAB_ALL) || (activeTab === TAB_UNSORTED) ) return null;
  return resolveCategory(activeTab, categories);
}

/* -------------------------------------------- */
/*  Text layout                                 */
/* -------------------------------------------- */

/**
 * Read a stash layout written like this:
 *
 *   # Bag Name
 *   ## Category Name 1
 *   *Keywords, separated, by, commas*
 *   ## Category Name 2
 *   *more, keywords*
 *
 * @returns {{name: string|null, categories: {name: string, keywords: string[]}[]}}
 */
export function parseLayoutText(text) {
  let name = null;
  const categories = [];
  let current = null;
  for ( const rawLine of String(text ?? "").split(/\r?\n/) ) {
    const line = rawLine.trim();
    if ( !line ) continue;
    let m;
    if ( (m = line.match(/^##+\s*(.*)$/)) ) {
      const catName = m[1].trim();
      if ( !catName ) { current = null; continue; }
      current = { name: catName, keywords: [] };
      categories.push(current);
    } else if ( (m = line.match(/^#\s*(.*)$/)) ) {
      if ( m[1].trim() ) name = m[1].trim();
      current = null;
    } else if ( current ) {
      current.keywords = parseKeywords([...current.keywords, ...parseKeywords(line)]);
    }
  }
  return { name, categories };
}

/** Write a stash layout back out in the same format parseLayoutText reads. */
export function layoutToText({ name, categories }) {
  const lines = [`# ${name ?? ""}`.trimEnd()];
  for ( const c of categories ?? [] ) {
    lines.push("", `## ${c.name}`);
    if ( c.keywords?.length ) lines.push(`*${c.keywords.join(", ")}*`);
  }
  return lines.join("\n");
}

/* -------------------------------------------- */
/*  Icons and text                              */
/* -------------------------------------------- */

/**
 * Pick `count` different icons from a pool at random, avoiding the ones in `exclude` where possible.
 * @param {string[]} pool
 * @param {number} count
 * @param {string[]} exclude
 * @param {() => number} random  Returns 0 <= n < 1.
 */
export function pickIcons(pool, count, exclude=[], random=Math.random) {
  const unique = [...new Set(pool)];
  const skip = new Set(exclude);
  let choices = unique.filter(p => !skip.has(p));
  if ( choices.length < count ) choices = unique;
  const arr = [...choices];
  for ( let i = arr.length - 1; i > 0; i-- ) {
    const j = Math.floor(random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, count);
}

/** Make text safe to put inside HTML. */
export function escapeHTML(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Move an entry in an array up (-1) or down (+1). Returns a new array. */
export function moveEntry(arr, index, delta) {
  const out = [...arr];
  const to = index + delta;
  if ( (index < 0) || (index >= out.length) || (to < 0) || (to >= out.length) ) return out;
  [out[index], out[to]] = [out[to], out[index]];
  return out;
}
