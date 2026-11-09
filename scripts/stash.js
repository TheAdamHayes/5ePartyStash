import { MODULE_ID, SETTINGS, DEFAULT_ICON, ICON_POOL, STASH_NAME, FOLDER_NAME } from "./constants.js";
import {
  FLAGS, TAB_ALL, DEFAULT_ACCENT, weightlessSystemData, findLooseItems, normalizeConfig, categoryForDrop, pickIcons,
  escapeHTML
} from "./logic.js";

/* -------------------------------------------- */
/*  Finding things                              */
/* -------------------------------------------- */

const makeId = () => foundry.utils.randomID(8);

/** @returns {Actor|undefined} The actor that really holds every stash. */
export function getStashActor() {
  return game.actors?.find(a => a.getFlag(MODULE_ID, FLAGS.STASH_ACTOR));
}

/** Is this a real stash container? */
export function isStash(item) {
  return !!item?.getFlag?.(MODULE_ID, FLAGS.STASH);
}

/** Is this a stash bag a player carries (or a sidebar item for one)? */
export function isProxy(item) {
  return !!item?.getFlag?.(MODULE_ID, FLAGS.PROXY);
}

/** Is this one of the sidebar items players drag into their inventory? */
export function isTemplate(item) {
  return !!item?.getFlag?.(MODULE_ID, FLAGS.TEMPLATE);
}

/** Is this the stash actor? */
export function isStashActor(actor) {
  return !!actor?.getFlag?.(MODULE_ID, FLAGS.STASH_ACTOR);
}

/** @returns {Item[]} Every stash, the main one first, then by name. */
export function getStashes() {
  const stashes = getStashActor()?.items.filter(i => isStash(i)) ?? [];
  return stashes.sort((a, b) => {
    const da = a.getFlag(MODULE_ID, FLAGS.DEFAULT) ? 0 : 1;
    const db = b.getFlag(MODULE_ID, FLAGS.DEFAULT) ? 0 : 1;
    return (da - db) || a.name.localeCompare(b.name);
  });
}

/** @returns {Item|undefined} The main stash (used for old bags that don't say which stash they open). */
export function getDefaultStash() {
  const stashes = getStashes();
  return stashes.find(s => s.getFlag(MODULE_ID, FLAGS.DEFAULT)) ?? stashes[0];
}

/** @returns {Item|undefined} */
export function getStash(id) {
  const item = id ? getStashActor()?.items.get(id) : null;
  return isStash(item) ? item : undefined;
}

/** Which stash does this carried bag / sidebar item open? */
export function stashForProxy(proxy) {
  return getStash(proxy?.getFlag?.(MODULE_ID, FLAGS.STASH_ID)) ?? getDefaultStash();
}

/** A stash's accent colour and tabs, cleaned up. */
export function getStashConfig(stash) {
  return normalizeConfig(stash?.getFlag?.(MODULE_ID, FLAGS.CONFIG), makeId);
}

/** Proxy bags carried by an actor. */
export function getProxies(actor) {
  return actor?.items?.filter(i => isProxy(i)) ?? [];
}

/** Does this item have a container slot (i.e. is it a physical item)? */
export function isPhysical(item) {
  return "container" in (item?._source?.system ?? {});
}

/** Can this user create new stashes and edit stash names, icons, colours and tabs? */
export function canManage(user=game.user) {
  if ( user?.isGM ) return true;
  try {
    return !!game.settings.get(MODULE_ID, SETTINGS.PLAYERS_MANAGE);
  } catch {
    return false;
  }
}

/* -------------------------------------------- */
/*  Which tab is open (per stash, this browser) */
/* -------------------------------------------- */

const activeTabs = new Map();

export function getActiveTab(stashId) {
  return activeTabs.get(stashId) ?? TAB_ALL;
}

export function setActiveTab(stashId, tabId) {
  activeTabs.set(stashId, tabId || TAB_ALL);
}

/** The tab an item dropped into this stash right now should go in, or null. */
export function dropCategory(stash) {
  if ( !stash ) return null;
  return categoryForDrop(getActiveTab(stash.id), getStashConfig(stash).categories);
}

/* -------------------------------------------- */
/*  Item data                                   */
/* -------------------------------------------- */

const DESCRIPTION = "<p><strong>Shared Party Stash.</strong> Open this bag to reach items shared by the whole party. "
  + "It weighs nothing and has no limit. Removing this bag from your inventory never loses any items: "
  + `drag this stash from the <em>${FOLDER_NAME}</em> folder in the Items sidebar into your inventory to get access back.</p>`;

function bagData({ name, img, flags, ownership, folder }) {
  const data = {
    name,
    type: "container",
    img: img || DEFAULT_ICON,
    system: {
      container: null,
      weight: { value: 0 },
      capacity: { count: null, volume: { value: null }, weight: { value: null } },
      properties: ["weightlessContents"],
      quantity: 1,
      identified: true,
      description: { value: DESCRIPTION }
    },
    flags: { [MODULE_ID]: flags }
  };
  if ( ownership ) data.ownership = ownership;
  if ( folder ) data.folder = folder;
  return data;
}

/** Changes that force a bag back to weightless/unlimited, but only the ones that differ. */
function bagRepairs(item) {
  const fix = {};
  for ( const [key, value] of Object.entries(weightlessSystemData()) ) {
    if ( foundry.utils.getProperty(item._source, key) !== value ) fix[key] = value;
  }
  const props = item._source.system?.properties ?? [];
  if ( !props.includes("weightlessContents") ) fix["system.properties"] = [...props, "weightlessContents"];
  return fix;
}

/** Options passed on the module's own housekeeping changes, so the hooks leave them alone. */
const INTERNAL = { [MODULE_ID]: { internal: true, confirmed: true } };

export function isInternal(options) {
  return !!options?.[MODULE_ID]?.internal;
}

/* -------------------------------------------- */
/*  Setup and repairs (GM only)                 */
/* -------------------------------------------- */

let queue = Promise.resolve();

/**
 * Make sure everything exists and matches up. Safe to call any time on the GM's client:
 * - the stash actor, and at least one stash on it
 * - every stash weightless, unlimited, and one marked as the main stash
 * - loose items on the stash actor put back into the main stash
 * - one sidebar item per stash in the "Party Stashes" folder, with the right name and picture
 * - carried bags pointing at a stash that still exists, with the right name and picture
 */
export function ensureStash() {
  if ( !game.user.isGM ) return Promise.resolve();
  queue = queue.then(runEnsure).catch(err => {
    console.error(`${MODULE_ID} | Setup failed.`, err);
    ui.notifications.error(`${STASH_NAME}: setup failed. See the browser console (F12) for details.`);
  });
  return queue;
}

async function runEnsure() {
  const OWNER = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
  const OBSERVER = CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER;

  // 1. The actor that really holds everything
  let actor = getStashActor();
  if ( !actor ) {
    actor = await Actor.implementation.create({
      name: STASH_NAME,
      type: "group",
      img: DEFAULT_ICON,
      ownership: { default: OWNER },
      flags: { [MODULE_ID]: { [FLAGS.STASH_ACTOR]: true } }
    });
    ui.notifications.info(`${STASH_NAME}: created the "${STASH_NAME}" actor. All players own it so they can use the stashes.`);
  }

  // 2. At least one stash, and one of them marked as the main stash
  let stashes = getStashes();
  if ( !stashes.length ) {
    await actor.createEmbeddedDocuments("Item", [bagData({
      name: STASH_NAME, img: DEFAULT_ICON,
      flags: { [FLAGS.STASH]: true, [FLAGS.DEFAULT]: true, [FLAGS.CONFIG]: { accent: DEFAULT_ACCENT, categories: [] } }
    })], INTERNAL);
    stashes = getStashes();
  }
  const main = getDefaultStash();
  const stashFixes = [];
  for ( const stash of stashes ) {
    const fix = bagRepairs(stash);
    if ( stash._source.system?.container ) fix["system.container"] = null;
    if ( (stash === main) && !stash.getFlag(MODULE_ID, FLAGS.DEFAULT) ) fix[`flags.${MODULE_ID}.${FLAGS.DEFAULT}`] = true;
    if ( !foundry.utils.isEmpty(fix) ) stashFixes.push({ _id: stash.id, ...fix });
  }
  if ( stashFixes.length ) await actor.updateEmbeddedDocuments("Item", stashFixes, INTERNAL);

  // 3. Put back any loose items (e.g. if a stash bag was deleted but its contents kept)
  const loose = findLooseItems(actor.items.map(i => ({
    id: i.id, container: i._source.system?.container ?? null, flags: i.flags, physical: isPhysical(i)
  })), MODULE_ID);
  if ( loose.length ) {
    await actor.updateEmbeddedDocuments("Item", loose.map(_id => ({
      _id, "system.container": main.id, [`flags.${MODULE_ID}.${FLAGS.CATEGORY}`]: null
    })), INTERNAL);
  }

  // 4. One sidebar item per stash, in the "Party Stashes" folder
  let folder = game.folders.find(f => (f.type === "Item") && f.getFlag(MODULE_ID, "folder"));
  if ( !folder ) {
    folder = await Folder.implementation.create({
      name: FOLDER_NAME, type: "Item", color: DEFAULT_ACCENT, flags: { [MODULE_ID]: { folder: true } }
    });
  }
  const ids = new Set(stashes.map(s => s.id));
  const templates = game.items.filter(i => isTemplate(i));
  const seen = new Set();
  const templateUpdates = [];
  const templateDeletes = [];
  for ( const t of templates ) {
    let sid = t.getFlag(MODULE_ID, FLAGS.STASH_ID);
    if ( !sid ) sid = main.id; // Made by an older version: belongs to the main stash
    const stash = ids.has(sid) ? getStash(sid) : null;
    if ( !stash || seen.has(sid) ) {
      templateDeletes.push(t.id);
      continue;
    }
    seen.add(sid);
    const fix = bagRepairs(t);
    if ( t.getFlag(MODULE_ID, FLAGS.STASH_ID) !== sid ) fix[`flags.${MODULE_ID}.${FLAGS.STASH_ID}`] = sid;
    if ( t.name !== stash.name ) fix.name = stash.name;
    if ( t.img !== stash.img ) fix.img = stash.img;
    if ( t.folder?.id !== folder.id ) fix.folder = folder.id;
    if ( !foundry.utils.isEmpty(fix) ) templateUpdates.push({ _id: t.id, ...fix });
  }
  if ( templateDeletes.length ) await Item.implementation.deleteDocuments(templateDeletes, INTERNAL);
  if ( templateUpdates.length ) await Item.implementation.updateDocuments(templateUpdates, INTERNAL);
  const missing = stashes.filter(s => !seen.has(s.id));
  if ( missing.length ) {
    await Item.implementation.createDocuments(missing.map(s => bagData({
      name: s.name, img: s.img, folder: folder.id, ownership: { default: OBSERVER },
      flags: { [FLAGS.PROXY]: true, [FLAGS.TEMPLATE]: true, [FLAGS.STASH_ID]: s.id }
    })), INTERNAL);
  }

  // 5. Bags that characters carry: point at a real stash, and match its name and picture
  await syncCarriedBags();
}

/** Bring carried bags in line with their stash (name, picture, which stash). Removes bags for deleted stashes. */
export async function syncCarriedBags() {
  if ( !game.user.isGM ) return;
  const main = getDefaultStash();
  if ( !main ) return;
  for ( const a of game.actors ) {
    if ( isStashActor(a) ) continue;
    const updates = [];
    const deletes = [];
    for ( const p of getProxies(a) ) {
      const sid = p.getFlag(MODULE_ID, FLAGS.STASH_ID);
      const stash = sid ? getStash(sid) : main;
      if ( !stash ) {
        deletes.push(p.id);
        continue;
      }
      const fix = bagRepairs(p);
      if ( !sid ) fix[`flags.${MODULE_ID}.${FLAGS.STASH_ID}`] = stash.id;
      if ( p.name !== stash.name ) fix.name = stash.name;
      if ( p.img !== stash.img ) fix.img = stash.img;
      if ( !foundry.utils.isEmpty(fix) ) updates.push({ _id: p.id, ...fix });
    }
    if ( deletes.length ) await a.deleteEmbeddedDocuments("Item", deletes, INTERNAL);
    if ( updates.length ) await a.updateEmbeddedDocuments("Item", updates, INTERNAL);
  }
}

/* -------------------------------------------- */
/*  Creating, editing and deleting stashes      */
/* -------------------------------------------- */

/**
 * Make a new stash.
 * @param {object} [data]
 * @param {string} [data.name]
 * @param {string} [data.img]
 * @param {string} [data.accent]
 * @param {object[]} [data.categories]
 * @returns {Promise<Item|null>}
 */
export async function createStash({ name, img, accent, categories }={}) {
  if ( !canManage() ) {
    ui.notifications.warn(`${STASH_NAME}: only the GM can create new stashes in this world.`);
    return null;
  }
  const actor = getStashActor();
  if ( !actor ) {
    ui.notifications.warn(`${STASH_NAME}: the stash isn't set up yet. The GM needs to log in to this world once with the module enabled.`);
    return null;
  }
  const taken = new Set(getStashes().map(s => s.name));
  let finalName = (name ?? "").trim() || "New Stash";
  for ( let n = 2; taken.has(finalName); n++ ) finalName = `${(name ?? "").trim() || "New Stash"} ${n}`;
  const config = normalizeConfig({ accent, categories }, makeId);
  const [stash] = await actor.createEmbeddedDocuments("Item", [bagData({
    name: finalName,
    img: img || pickIcons(ICON_POOL, 1, getStashes().map(s => s.img))[0],
    flags: { [FLAGS.STASH]: true, [FLAGS.CONFIG]: config }
  })], INTERNAL);
  if ( !stash ) return null;

  // A player gets the new bag straight away (the GM's client adds the sidebar item for everyone else).
  const character = game.user.isGM ? null : game.user.character;
  if ( character?.isOwner ) await giveBag(stash, character);
  ui.notifications.info(`${STASH_NAME}: created "${stash.name}".`);
  return stash;
}

/**
 * Save a stash's name, picture, accent colour and tabs.
 * @param {Item} stash
 * @param {object} data
 */
export async function updateStash(stash, { name, img, accent, categories }) {
  if ( !canManage() ) {
    ui.notifications.warn(`${STASH_NAME}: only the GM can edit stashes in this world.`);
    return null;
  }
  const config = normalizeConfig({ accent, categories }, makeId);
  const update = { [`flags.${MODULE_ID}.${FLAGS.CONFIG}`]: config };
  if ( name?.trim() ) update.name = name.trim();
  if ( img ) update.img = img;
  // (The tab list is an array, so saving it replaces the old list as a whole.)
  return stash.update(update, INTERNAL);
}

/** Put a bag for this stash in a character's inventory. */
export async function giveBag(stash, actor) {
  if ( !stash || !actor || isStashActor(actor) ) return null;
  if ( getProxies(actor).some(p => stashForProxy(p)?.id === stash.id) ) return null;
  const [bag] = await actor.createEmbeddedDocuments("Item", [bagData({
    name: stash.name, img: stash.img, flags: { [FLAGS.PROXY]: true, [FLAGS.STASH_ID]: stash.id }
  })]);
  return bag;
}

/**
 * Delete a stash for good (GM only), after asking what to do with its items.
 * @param {Item} stash
 */
export async function deleteStash(stash) {
  const { DialogV2 } = foundry.applications.api;
  if ( !game.user.isGM ) {
    ui.notifications.warn(`${STASH_NAME}: only the GM can delete a stash.`);
    return null;
  }
  if ( !stash ) return null;
  const others = getStashes().filter(s => s.id !== stash.id);
  if ( !others.length ) {
    ui.notifications.warn(`${STASH_NAME}: you can't delete the only stash. Make another one first.`);
    return null;
  }
  const contents = stash.actor.items.filter(i => i._source.system?.container === stash.id);
  const target = (stash === getDefaultStash()) ? others[0] : getDefaultStash();

  const buttons = [];
  if ( contents.length ) {
    buttons.push({ action: "move", label: `Move items to "${escapeHTML(target.name)}"`, icon: "fa-solid fa-right-left", default: true });
    buttons.push({ action: "destroy", label: "Delete items too", icon: "fa-solid fa-fire" });
  } else {
    buttons.push({ action: "destroy", label: "Delete Stash", icon: "fa-solid fa-trash", default: true });
  }
  buttons.push({ action: "cancel", label: "Cancel", icon: "fa-solid fa-xmark" });

  const choice = await DialogV2.wait({
    window: { title: `Delete "${stash.name}"?`, icon: "fa-solid fa-triangle-exclamation" },
    position: { width: 480 },
    content: `
      <p>You're about to delete the stash <strong>${escapeHTML(stash.name)}</strong>
      (${contents.length} item(s) directly inside it).</p>
      <p>Characters carrying this stash's bag lose it, and its item in the Items sidebar is removed.</p>
      ${contents.length ? `<p>What should happen to the items inside?</p>` : ""}`,
    buttons,
    rejectClose: false
  });
  if ( !choice || (choice === "cancel") ) return null;

  if ( choice === "move" ) {
    await stash.actor.updateEmbeddedDocuments("Item", contents.map(i => ({
      _id: i.id, "system.container": target.id, [`flags.${MODULE_ID}.${FLAGS.CATEGORY}`]: null
    })), INTERNAL);
  }
  const wasMain = stash.getFlag(MODULE_ID, FLAGS.DEFAULT);
  await stash.delete({ deleteContents: choice === "destroy", ...INTERNAL });
  if ( wasMain && others[0] ) await others[0].setFlag(MODULE_ID, FLAGS.DEFAULT, true);
  await ensureStash();
  ui.notifications.info(`${STASH_NAME}: deleted "${stash.name}".`);
  return true;
}

/* -------------------------------------------- */
/*  Opening and moving                          */
/* -------------------------------------------- */

/**
 * Open a stash's window.
 * @param {Item|string} [stashOrId]  The stash or its id. Leave out to open the main stash.
 */
export function openStash(stashOrId) {
  const stash = (typeof stashOrId === "string") ? getStash(stashOrId) : (stashOrId ?? getDefaultStash());
  if ( !stash ) {
    ui.notifications.warn(`${STASH_NAME}: the stash isn't set up yet. The GM needs to log in to this world once with the module enabled.`);
    return null;
  }
  if ( !stash.isOwner ) {
    ui.notifications.warn(`${STASH_NAME}: you don't have permission to use the stash. The GM should set the "${STASH_NAME}" actor's default ownership to Owner.`);
  }
  return stash.sheet.render({ force: true });
}

/**
 * Move an item (and anything inside it) into a stash.
 * @param {Item} item
 * @param {Item} [stash]       Which stash. Defaults to the main stash.
 * @param {string|null} [category]  Which tab. Defaults to the tab open in that stash's window.
 */
export async function transferToStash(item, stash, category) {
  stash ??= getDefaultStash();
  const actor = getStashActor();
  if ( !actor || !stash ) return openStash();
  if ( isProxy(item) || isStash(item) ) {
    ui.notifications.warn(`${STASH_NAME}: a stash bag can't be put inside a stash.`);
    return;
  }
  if ( !isPhysical(item) ) {
    ui.notifications.warn(`${STASH_NAME}: only physical items can go in a stash.`);
    return;
  }
  if ( !stash.isOwner ) return openStash(stash);
  if ( category === undefined ) category = dropCategory(stash);

  // Already on the stash actor (e.g. moving between two stashes): just move it across.
  if ( item.actor === actor ) {
    if ( (item._source.system?.container === stash.id) && (item.getFlag(MODULE_ID, FLAGS.CATEGORY) ?? null) === category ) return;
    await item.update({ "system.container": stash.id, [`flags.${MODULE_ID}.${FLAGS.CATEGORY}`]: category }, INTERNAL);
    return;
  }

  const Item5e = CONFIG.Item.documentClass;
  const toCreate = await Item5e.createWithContents([item], { container: stash });
  if ( !toCreate?.length ) return;
  const top = toCreate.find(d => foundry.utils.getProperty(d, "system.container") === stash.id) ?? toCreate[0];
  foundry.utils.setProperty(top, `flags.${MODULE_ID}.${FLAGS.CATEGORY}`, category);
  await Item5e.createDocuments(toCreate, { parent: actor, keepId: true });
  // Remove it from the character (items dragged from the sidebar or a compendium are just copied in).
  if ( item.parent && item.isOwner ) await item.delete({ deleteContents: true });
  ui.notifications.info(`${STASH_NAME}: ${item.name} added to "${stash.name}".`);
}

/**
 * Put an item that's already in a stash onto a tab (dragged onto a tab button).
 * @param {Item} item
 * @param {Item} stash
 * @param {string|null} category
 */
export async function setItemCategory(item, stash, category) {
  if ( item.actor !== stash.actor ) return transferToStash(item, stash, category);
  return item.update({ "system.container": stash.id, [`flags.${MODULE_ID}.${FLAGS.CATEGORY}`]: category }, INTERNAL);
}

export { pickIcons };
