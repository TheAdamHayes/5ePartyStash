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

/** Same, but also marks a brand-new stash so the GM's client hands its bag out to everyone. */
const NEW_STASH = { [MODULE_ID]: { internal: true, confirmed: true, newStash: true } };

export function isNewStash(options) {
  return !!options?.[MODULE_ID]?.newStash;
}

/** Should new stashes go straight into every player character's inventory? */
export function autoGive() {
  try {
    return !!game.settings.get(MODULE_ID, SETTINGS.AUTO_GIVE);
  } catch {
    return false;
  }
}

export function isInternal(options) {
  return !!options?.[MODULE_ID]?.internal;
}

/* -------------------------------------------- */
/*  Setup and repairs (GM only)                 */
/* -------------------------------------------- */

let queue = Promise.resolve();

/** The collection an update is aimed at: an actor's items, or the Items sidebar. */
const itemsOf = owner => (owner ? owner.items : game.items);

/**
 * Update items, skipping any that no longer exist. If the batch fails, try them one at a time so one
 * bad item can't stop the rest, and log exactly which item failed.
 */
async function safeUpdate(owner, updates, step) {
  const coll = itemsOf(owner);
  const valid = updates.filter(u => coll.has(u._id));
  if ( !valid.length ) return;
  try {
    if ( owner ) await owner.updateEmbeddedDocuments("Item", valid, INTERNAL);
    else await Item.implementation.updateDocuments(valid, INTERNAL);
  } catch ( err ) {
    console.warn(`${MODULE_ID} | ${step}: batch update failed, retrying one at a time.`, err);
    for ( const { _id, ...changes } of valid ) {
      const doc = coll.get(_id);
      if ( !doc ) continue;
      try {
        await doc.update(changes, INTERNAL);
      } catch ( e ) {
        console.warn(`${MODULE_ID} | ${step}: could not update "${doc.name}" [${_id}] on ${owner?.name ?? "the Items sidebar"}.`, changes, e);
      }
    }
  }
}

/** Delete items, skipping any that are already gone. */
async function safeDelete(owner, ids, step) {
  const coll = itemsOf(owner);
  for ( const id of ids ) {
    const doc = coll.get(id);
    if ( !doc ) continue;
    try {
      await doc.delete(INTERNAL);
    } catch ( e ) {
      console.warn(`${MODULE_ID} | ${step}: could not delete "${doc.name}" [${id}].`, e);
    }
  }
}

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
  // If the world is open as GM in several tabs of the same browser, they take turns instead of running setup
  // at the same time (which made them trip over each other). Falls back to running directly if unsupported.
  const run = () => (navigator.locks?.request
    ? navigator.locks.request(`${MODULE_ID}-setup-${game.world?.id ?? ""}`, () => runEnsure())
    : runEnsure());
  queue = queue.then(run).catch(err => {
    console.error(`${MODULE_ID} | Setup failed.`, err);
    ui.notifications.error(`${STASH_NAME}: setup failed. See the browser console (F12) for details.`);
  });
  return queue;
}

/** Run one setup step; if it fails, log it and carry on with the next step. */
async function step(name, fn) {
  try {
    await fn();
    return true;
  } catch ( err ) {
    console.error(`${MODULE_ID} | Setup step "${name}" failed. The other steps still ran.`, err);
    ui.notifications.warn(`${STASH_NAME}: setup step "${name}" had a problem. Your stash items are safe. See the browser console (F12) for details.`);
    return false;
  }
}

async function runEnsure() {
  const OWNER = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;

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
    })], NEW_STASH);
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
  await step("repair stashes", () => safeUpdate(actor, stashFixes, "repair stashes"));

  // 3. Put back any loose items (e.g. if a stash bag was deleted but its contents kept)
  await step("put back loose items", () => {
    const loose = findLooseItems(actor.items.map(i => ({
      id: i.id, container: i._source.system?.container ?? null, flags: i.flags, physical: isPhysical(i)
    })), MODULE_ID);
    return safeUpdate(actor, loose.map(_id => ({
      _id, "system.container": main.id, [`flags.${MODULE_ID}.${FLAGS.CATEGORY}`]: null
    })), "put back loose items");
  });

  await step("sidebar items", () => syncTemplates(stashes, main));

  // 5. Bags that characters carry: point at a real stash, and match its name and picture
  await step("carried bags", () => syncCarriedBags());
}

/** 4. One sidebar item per stash, in the "Party Stashes" folder. */
async function syncTemplates(stashes, main) {
  const OBSERVER = CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER;

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
    // Not this stash's item, a duplicate, or outside the folder: replace it with a fresh one.
    // (Moving a bag between folders makes dnd5e try to move its contents as well, so we don't move it.)
    if ( !stash || seen.has(sid) || (t.folder?.id !== folder.id) ) {
      templateDeletes.push(t.id);
      continue;
    }
    seen.add(sid);
    const fix = bagRepairs(t);
    if ( t.getFlag(MODULE_ID, FLAGS.STASH_ID) !== sid ) fix[`flags.${MODULE_ID}.${FLAGS.STASH_ID}`] = sid;
    if ( t.name !== stash.name ) fix.name = stash.name;
    if ( t.img !== stash.img ) fix.img = stash.img;
    if ( !foundry.utils.isEmpty(fix) ) templateUpdates.push({ _id: t.id, ...fix });
  }
  await safeDelete(null, templateDeletes, "sidebar items");
  await safeUpdate(null, templateUpdates, "sidebar items");
  const missing = stashes.filter(s => !seen.has(s.id));
  if ( missing.length ) {
    await Item.implementation.createDocuments(missing.map(s => bagData({
      name: s.name, img: s.img, folder: folder.id, ownership: { default: OBSERVER },
      flags: { [FLAGS.PROXY]: true, [FLAGS.TEMPLATE]: true, [FLAGS.STASH_ID]: s.id }
    })), INTERNAL);
  }
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
    await safeDelete(a, deletes, "carried bags");
    await safeUpdate(a, updates, "carried bags");
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
  })], NEW_STASH);
  if ( !stash ) return null;

  // The GM's client makes the sidebar item and (if switched on) gives every player character the bag.
  // If no GM is online, or bags aren't handed out automatically, a player at least gets it themselves.
  const character = game.user.isGM ? null : game.user.character;
  if ( character?.isOwner && (!game.users.activeGM || !autoGive()) ) await giveBag(stash, character);
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
 * Characters that belong to players: every character a non-GM player owns, plus each player's assigned character.
 * @returns {Actor[]}
 */
export function getPlayerCharacters() {
  const players = game.users.filter(u => !u.isGM);
  const out = new Set();
  for ( const u of players ) if ( u.character && !isStashActor(u.character) ) out.add(u.character);
  for ( const a of game.actors ) {
    if ( (a.type !== "character") || isStashActor(a) ) continue;
    if ( players.some(u => a.testUserPermission(u, "OWNER")) ) out.add(a);
  }
  return [...out].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Put this stash's bag in every player character's inventory (GM only). Characters who already have it are skipped.
 * @returns {Promise<string[]>}  Names of the characters who got a bag.
 */
export async function giveToEveryone(stash) {
  if ( !stash || !game.user.isGM ) return [];
  const given = [];
  for ( const actor of getPlayerCharacters() ) {
    try {
      if ( await giveBag(stash, actor) ) given.push(actor.name);
    } catch ( err ) {
      console.warn(`${MODULE_ID} | Could not give "${stash.name}" to ${actor.name}.`, err);
    }
  }
  return given;
}

/**
 * Take this stash's bag back from every character (GM only). No stash items are lost.
 * @returns {Promise<string[]>}  Names of the characters whose bag was removed.
 */
export async function takeFromEveryone(stash) {
  if ( !stash || !game.user.isGM ) return [];
  const taken = [];
  for ( const actor of game.actors ) {
    if ( isStashActor(actor) ) continue;
    const ids = getProxies(actor).filter(p => stashForProxy(p)?.id === stash.id).map(p => p.id);
    if ( !ids.length ) continue;
    await safeDelete(actor, ids, "take bags back");
    taken.push(actor.name);
  }
  return taken;
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
