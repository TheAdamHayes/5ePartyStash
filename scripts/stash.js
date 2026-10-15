import { MODULE_ID, SETTINGS, DEFAULT_ICON, STASH_NAME, TEMPLATE_NAME } from "./constants.js";
import { FLAGS, weightlessSystemData, findLooseItems } from "./logic.js";

/* -------------------------------------------- */
/*  Finding things                              */
/* -------------------------------------------- */

export function getIcon() {
  try {
    return game.settings.get(MODULE_ID, SETTINGS.ICON) || DEFAULT_ICON;
  } catch {
    return DEFAULT_ICON;
  }
}

/** @returns {Actor|undefined} The actor that really holds the party's items. */
export function getStashActor() {
  return game.actors?.find(a => a.getFlag(MODULE_ID, FLAGS.STASH_ACTOR));
}

/** @returns {Item|undefined} The real stash container on the stash actor. */
export function getStashContainer() {
  return getStashActor()?.items.find(i => i.getFlag(MODULE_ID, FLAGS.STASH));
}

/** @returns {Item|undefined} The world item players drag into their inventory. */
export function getTemplateItem() {
  return game.items?.find(i => i.getFlag(MODULE_ID, FLAGS.TEMPLATE));
}

/** Is this the real stash container? */
export function isStash(item) {
  return !!item?.getFlag?.(MODULE_ID, FLAGS.STASH);
}

/** Is this a "Shared Party Stash" bag a player carries (or the sidebar template)? */
export function isProxy(item) {
  return !!item?.getFlag?.(MODULE_ID, FLAGS.PROXY);
}

/** Is this the stash actor? */
export function isStashActor(actor) {
  return !!actor?.getFlag?.(MODULE_ID, FLAGS.STASH_ACTOR);
}

/** Proxy bags carried by an actor. */
export function getProxies(actor) {
  return actor?.items?.filter(i => isProxy(i)) ?? [];
}

/** Does this item have a container slot (i.e. is it a physical item)? */
function isPhysical(item) {
  return "container" in (item?._source?.system ?? {});
}

/* -------------------------------------------- */
/*  Item data                                   */
/* -------------------------------------------- */

function bagData({ name, flags, ownership }) {
  const data = {
    name,
    type: "container",
    img: getIcon(),
    system: {
      weight: { value: 0 },
      capacity: { count: null, volume: { value: null }, weight: { value: null } },
      properties: ["weightlessContents"],
      quantity: 1,
      identified: true,
      description: {
        value: "<p><strong>Shared Party Stash.</strong> Open this bag to reach the party's shared items. "
          + "It weighs nothing and has no limit. Removing this bag from your inventory never loses any items: "
          + "drag another <em>Shared Party Stash</em> from the Items sidebar into your inventory to get access back.</p>"
      }
    },
    flags: { [MODULE_ID]: flags }
  };
  if ( ownership ) data.ownership = ownership;
  return data;
}

/** Changes that force a bag back to weightless/unlimited, but only the ones that differ. */
function bagRepairs(item) {
  const fix = {};
  const want = weightlessSystemData();
  for ( const [key, value] of Object.entries(want) ) {
    if ( foundry.utils.getProperty(item._source, key) !== value ) fix[key] = value;
  }
  const props = item._source.system?.properties ?? [];
  if ( !props.includes("weightlessContents") ) fix["system.properties"] = [...props, "weightlessContents"];
  return fix;
}

/* -------------------------------------------- */
/*  Setup (GM only)                             */
/* -------------------------------------------- */

/** Make sure the stash actor, stash container and sidebar item all exist. Runs on the GM's client. */
export async function ensureStash() {
  if ( !game.user.isGM ) return;
  const OWNER = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
  const OBSERVER = CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER;

  // 1. The actor that really holds everything
  let actor = getStashActor();
  if ( !actor ) {
    actor = await Actor.implementation.create({
      name: STASH_NAME,
      type: "group",
      img: getIcon(),
      ownership: { default: OWNER },
      flags: { [MODULE_ID]: { [FLAGS.STASH_ACTOR]: true } }
    });
    ui.notifications.info(`${STASH_NAME}: created the "${STASH_NAME}" actor. All players own it so they can use the stash.`);
  }

  // 2. The real stash bag on that actor
  let container = getStashContainer();
  if ( !container ) {
    [container] = await actor.createEmbeddedDocuments("Item", [
      bagData({ name: STASH_NAME, flags: { [FLAGS.STASH]: true } })
    ]);
  } else {
    const fix = bagRepairs(container);
    if ( !foundry.utils.isEmpty(fix) ) await container.update(fix);
  }

  // Put back any loose items (e.g. if the stash bag was deleted but its contents kept)
  const loose = findLooseItems(actor.items.map(i => ({
    id: i.id, container: i._source.system?.container ?? null, flags: i.flags, physical: isPhysical(i)
  })), container.id, MODULE_ID);
  if ( loose.length ) {
    await actor.updateEmbeddedDocuments("Item", loose.map(_id => ({ _id, "system.container": container.id })));
  }

  // 3. The item in the Items sidebar that players drag into their inventory
  const template = getTemplateItem();
  if ( !template ) {
    await Item.implementation.create(bagData({
      name: TEMPLATE_NAME,
      flags: { [FLAGS.PROXY]: true, [FLAGS.TEMPLATE]: true },
      ownership: { default: OBSERVER }
    }));
  }
}

/** Update the picture on every stash bag when the GM changes the icon setting. */
export async function applyIcon() {
  if ( !game.user.isGM ) return;
  const img = getIcon();
  const actor = getStashActor();
  if ( actor && (actor.img !== img) ) await actor.update({ img });
  const container = getStashContainer();
  if ( container && (container.img !== img) ) await container.update({ img });
  const template = getTemplateItem();
  if ( template && (template.img !== img) ) await template.update({ img });
  for ( const a of game.actors ) {
    const updates = getProxies(a).filter(p => p.img !== img).map(p => ({ _id: p.id, img }));
    if ( updates.length ) await a.updateEmbeddedDocuments("Item", updates);
  }
}

/* -------------------------------------------- */
/*  Opening and moving                          */
/* -------------------------------------------- */

/** Open the shared stash window. */
export function openStash() {
  const container = getStashContainer();
  if ( !container ) {
    ui.notifications.warn(`${STASH_NAME}: the stash isn't set up yet. The GM needs to log in to this world once with the module enabled.`);
    return null;
  }
  if ( !container.isOwner ) {
    ui.notifications.warn(`${STASH_NAME}: you don't have permission to use the stash. The GM should set the "${STASH_NAME}" actor's default ownership to Owner.`);
  }
  return container.sheet.render({ force: true });
}

/**
 * Move an item (and anything inside it) from a character into the shared stash.
 * @param {Item} item
 */
export async function transferToStash(item) {
  const actor = getStashActor();
  const container = getStashContainer();
  if ( !actor || !container ) return openStash();
  if ( item.actor === actor ) return; // already in the stash actor
  if ( isProxy(item) || isStash(item) ) {
    ui.notifications.warn(`${STASH_NAME}: the stash bag can't be put inside the stash.`);
    return;
  }
  if ( !isPhysical(item) ) {
    ui.notifications.warn(`${STASH_NAME}: only physical items can go in the stash.`);
    return;
  }
  if ( !container.isOwner ) return openStash();

  const Item5e = CONFIG.Item.documentClass;
  const toCreate = await Item5e.createWithContents([item], { container });
  if ( !toCreate?.length ) return;
  await Item5e.createDocuments(toCreate, { parent: actor, keepId: true });
  // Remove it from the character (items dragged from the sidebar or a compendium are just copied in).
  if ( item.parent && item.isOwner ) await item.delete({ deleteContents: true });
  ui.notifications.info(`${STASH_NAME}: ${item.name} added to the party stash.`);
}
