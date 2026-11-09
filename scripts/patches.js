import { MODULE_ID, STASH_NAME, FOLDER_NAME } from "./constants.js";
import { FLAGS, decideDropBehavior, sanitizeBagChanges, weightlessSystemData, escapeHTML } from "./logic.js";
import {
  autoGive, giveToEveryone, isNewStash, canManage, deleteStash, dropCategory, ensureStash, getStash, getStashActor, getStashes, getProxies, isInternal,
  isProxy, isStash, isStashActor, isTemplate, openStash, stashForProxy, transferToStash
} from "./stash.js";

const { DialogV2 } = foundry.applications.api;

/** Read the drag payload from an event (works during dragover and drop). */
function readDragData(event, data) {
  if ( data ) return data;
  try {
    const payload = CONFIG.ux.DragDrop?.getPayload?.(event);
    if ( payload ) return payload;
  } catch { /* ignore */ }
  try {
    return foundry.applications.ux.TextEditor.implementation.getDragEventData(event);
  } catch {
    return null;
  }
}

/** Wrap a sheet's _dropBehavior so items always MOVE into and out of the stash, never duplicate. */
function wrapDropBehavior(proto, getTargetActor) {
  const original = proto._dropBehavior;
  if ( typeof original !== "function" ) {
    console.warn(`${MODULE_ID} | Could not find _dropBehavior to patch.`);
    return;
  }
  proto._dropBehavior = function(event, data) {
    const result = original.call(this, event, data);
    try {
      const payload = readDragData(event, data);
      const source = payload?.uuid ? fromUuidSync(payload.uuid) : null;
      return decideDropBehavior({
        result,
        isItem: payload?.type === "Item",
        sourceActorId: source?.actor?.id ?? null,
        targetActorId: getTargetActor.call(this)?.id ?? null,
        stashActorId: getStashActor()?.id ?? null,
        isGM: game.user.isGM,
        copyKey: !!(event?.ctrlKey || event?.altKey)
      });
    } catch ( err ) {
      console.error(`${MODULE_ID} |`, err);
      return result;
    }
  };
}

/* -------------------------------------------- */
/*  Confirmation dialogs                        */
/* -------------------------------------------- */

async function confirmProxyRemoval(item, operation) {
  const yes = await DialogV2.confirm({
    window: { title: `Remove ${item.name}?`, icon: "fa-solid fa-people-carry-box" },
    position: { width: 440 },
    content: `
      <p><strong>This is a Shared Party Stash bag.</strong></p>
      <p>Removing it from your inventory will <strong>not</strong> delete or lose any items. Everything stays
      safely in the stash for the rest of the group.</p>
      <p>To get access back later, drag <em>${escapeHTML(item.name)}</em> from the <em>${FOLDER_NAME}</em>
      folder in the Items sidebar into your inventory again.</p>
      <p>Remove the stash bag from your inventory?</p>`,
    yes: { label: "Remove Bag", icon: "fa-solid fa-trash" },
    no: { label: "Keep It", icon: "fa-solid fa-xmark", default: true },
    rejectClose: false
  });
  if ( yes ) return item.delete(operation);
  return null;
}

async function confirmStashActorDeletion(actor) {
  const count = actor.items.filter(i => !isStash(i)).length;
  const yes = await DialogV2.confirm({
    window: { title: `Delete the ${STASH_NAME} actor?`, icon: "fa-solid fa-triangle-exclamation" },
    position: { width: 460 },
    content: `
      <p><strong>Warning:</strong> the "${escapeHTML(actor.name)}" actor holds <strong>every</strong> party stash
      and all ${count} item(s) in them. Deleting it destroys all of them for good.</p>
      <p>A new, empty stash is made straight away. Are you sure?</p>`,
    yes: { label: "Delete Everything", icon: "fa-solid fa-trash" },
    no: { label: "Cancel", default: true },
    rejectClose: false
  });
  if ( yes ) return actor.delete({ [MODULE_ID]: { confirmed: true } });
  return null;
}

/* -------------------------------------------- */
/*  Patches (run once on init)                  */
/* -------------------------------------------- */

export function applyPatches() {
  const BaseActorSheet = globalThis.dnd5e?.applications?.actor?.BaseActorSheet;
  const ContainerSheet = globalThis.dnd5e?.applications?.item?.ContainerSheet;
  const Item5e = CONFIG.Item.documentClass;

  // Moving items in/out of the stash always moves them (no duplicates).
  if ( BaseActorSheet ) {
    wrapDropBehavior(BaseActorSheet.prototype, function() { return this.inventorySource ?? this.actor; });

    // Dropping an item onto a stash bag icon puts it in that stash.
    const originalDropContainer = BaseActorSheet.prototype._onDropItemContainer;
    if ( typeof originalDropContainer === "function" ) {
      BaseActorSheet.prototype._onDropItemContainer = async function(event, item, container) {
        if ( isProxy(container) ) return transferToStash(item, stashForProxy(container));
        return originalDropContainer.call(this, event, item, container);
      };
    }
  } else {
    console.warn(`${MODULE_ID} | dnd5e BaseActorSheet not found; drag-and-drop moving may fall back to copying.`);
  }

  if ( ContainerSheet ) {
    wrapDropBehavior(ContainerSheet.prototype, function() { return this.item?.actor; });

    // Opening any stash bag opens its real stash instead.
    const originalRender = ContainerSheet.prototype.render;
    ContainerSheet.prototype.render = function(options, ...rest) {
      if ( isProxy(this.item) ) {
        const force = (typeof options === "boolean") ? options : options?.force;
        if ( force ) openStash(stashForProxy(this.item));
        return this;
      }
      return originalRender.call(this, options, ...rest);
    };
  }

  // Confirmation before throwing away a stash bag (or a real stash).
  const originalDeleteDialog = Item5e.prototype.deleteDialog;
  Item5e.prototype.deleteDialog = async function(dialogOptions={}, operation={}) {
    if ( isStash(this) ) return deleteStash(this);
    if ( isProxy(this) && this.parent ) return confirmProxyRemoval(this, operation);
    return originalDeleteDialog.call(this, dialogOptions, operation);
  };
}

/* -------------------------------------------- */
/*  Document hooks                              */
/* -------------------------------------------- */

const STASH_EDIT_KEYS = /^(name|img|flags\.ah-5e-party-stash\.config)/;

export function registerHooks() {
  Hooks.on("preCreateItem", (item, data, options, userId) => {
    if ( userId !== game.user.id ) return;
    const parent = item.parent;

    // Only allowed users may make new stashes.
    if ( isStash(item) && !isInternal(options) ) {
      if ( !canManage() || !isStashActor(parent) ) {
        ui.notifications.warn(`${STASH_NAME}: only the GM can create new stashes in this world.`);
        return false;
      }
      // A copy (e.g. duplicated stash) is never the main stash.
      item.updateSource({ ...weightlessSystemData(), [`flags.${MODULE_ID}.${FLAGS.DEFAULT}`]: false });
      return;
    }

    // Carried bags are always weightless, and never go inside the stash actor.
    if ( isProxy(item) && parent ) {
      if ( isStashActor(parent) ) {
        ui.notifications.warn(`${STASH_NAME}: a stash bag can't be put inside a stash.`);
        return false;
      }
      item.updateSource(weightlessSystemData());
      return;
    }

    const containerId = foundry.utils.getProperty(data, "system.container");
    const target = containerId ? parent?.items.get(containerId) : null;

    // Something being created directly inside a carried stash bag: send it to the real stash.
    if ( isProxy(target) ) {
      const stash = stashForProxy(target);
      if ( !stash ) return false;
      const createData = foundry.utils.deepClone(data);
      delete createData._id;
      foundry.utils.setProperty(createData, "system.container", stash.id);
      foundry.utils.setProperty(createData, `flags.${MODULE_ID}.${FLAGS.CATEGORY}`, dropCategory(stash));
      stash.actor.createEmbeddedDocuments("Item", [createData]);
      return false;
    }

    // Dropped into a stash window while a tab is open: put it on that tab.
    if ( isStash(target) && (foundry.utils.getProperty(data, `flags.${MODULE_ID}.${FLAGS.CATEGORY}`) === undefined) ) {
      item.updateSource({ [`flags.${MODULE_ID}.${FLAGS.CATEGORY}`]: dropCategory(target) });
    }
  });

  Hooks.on("preUpdateItem", (item, changes, options, userId) => {
    if ( userId !== game.user.id ) return;

    if ( isProxy(item) || isStash(item) ) {
      const flat = foundry.utils.flattenObject(changes);

      // Only allowed users may rename a stash or change its picture, colour or tabs.
      if ( isStash(item) && !isInternal(options) && !canManage() && Object.keys(flat).some(k => STASH_EDIT_KEYS.test(k)) ) {
        ui.notifications.warn(`${STASH_NAME}: only the GM can edit stashes in this world.`);
        return false;
      }

      // Stash bags always weigh nothing and have no limit.
      const touchesBag = Object.keys(flat).some(k => /^system\.(weight|capacity|quantity|properties|identified)/.test(k));
      if ( touchesBag ) {
        sanitizeBagChanges(flat);
        for ( const key of Object.keys(changes) ) delete changes[key];
        Object.assign(changes, foundry.utils.expandObject(flat));
      }
      return;
    }

    const containerId = foundry.utils.getProperty(changes, "system.container");
    if ( !containerId || !item.parent || isInternal(options) ) return;
    const target = item.parent.items.get(containerId);

    // Moving an item into a carried stash bag: send it to the real stash instead.
    if ( isProxy(target) ) {
      transferToStash(item, stashForProxy(target));
      return false;
    }

    // Moving an item into a stash window (e.g. from another stash): put it on the open tab.
    if ( isStash(target) && (containerId !== item._source.system?.container)
      && (foundry.utils.getProperty(changes, `flags.${MODULE_ID}.${FLAGS.CATEGORY}`) === undefined) ) {
      foundry.utils.setProperty(changes, `flags.${MODULE_ID}.${FLAGS.CATEGORY}`, dropCategory(target));
    }
  });

  // Never lose a real stash by accident.
  Hooks.on("preDeleteItem", (item, options, userId) => {
    if ( !isStash(item) || options?.[MODULE_ID]?.confirmed ) return;
    if ( userId === game.user.id ) deleteStash(item);
    return false;
  });

  Hooks.on("preDeleteActor", (actor, options, userId) => {
    if ( !isStashActor(actor) || options?.[MODULE_ID]?.confirmed ) return;
    if ( userId === game.user.id ) {
      if ( game.user.isGM ) confirmStashActorDeletion(actor);
      else ui.notifications.warn(`${STASH_NAME}: only the GM can delete the stash actor.`);
    }
    return false;
  });

  // ----- Housekeeping on the GM's client (keeps sidebar items and carried bags in step) -----

  const isActiveGM = () => game.user.isGM && (game.users.activeGM?.id === game.user.id);

  // A new stash (possibly made by a player): give it a sidebar item, and hand its bag to every
  // player character if that's switched on in the overview.
  Hooks.on("createItem", async (item, options) => {
    if ( !isStash(item) || !isActiveGM() ) return;
    await ensureStash();
    if ( isNewStash(options) && autoGive() ) {
      const given = await giveToEveryone(item);
      if ( given.length ) ui.notifications.info(`${STASH_NAME}: gave "${item.name}" to ${given.join(", ")}.`);
    }
  });

  // A stash renamed or given a new picture: update its sidebar item and carried bags.
  Hooks.on("updateItem", (item, changes) => {
    if ( !isStash(item) || !isActiveGM() ) return;
    if ( ("name" in changes) || ("img" in changes) ) ensureStash();
  });

  Hooks.on("deleteItem", (item, options) => {
    if ( !isActiveGM() || isInternal(options) ) return;
    if ( isStash(item) ) ensureStash();

    // A stash's sidebar item was deleted: put a fresh one back straight away.
    // (Nothing in the stash is affected; this item is only the key players drag into their inventory.)
    else if ( !item.parent && isTemplate(item) ) {
      const stash = getStash(item.getFlag(MODULE_ID, FLAGS.STASH_ID)) ?? getStashes()[0];
      ensureStash().then(() => {
        if ( stash ) ui.notifications.info(`${STASH_NAME}: players need the "${stash.name}" item to reach that stash, so it has been put back in the ${FOLDER_NAME} folder. No stash items were affected.`);
      });
    }
  });

  Hooks.on("deleteActor", actor => {
    if ( isStashActor(actor) && isActiveGM() ) ensureStash();
  });

  // Don't put a stash bag inside a stash.
  Hooks.on("dnd5e.dropItemSheetData", (container, sheet, data) => {
    if ( !(isStash(container) || isProxy(container)) || (data?.type !== "Item") || !data.uuid ) return;
    const dropped = fromUuidSync(data.uuid);
    if ( isProxy(dropped) || isStash(dropped) ) {
      ui.notifications.warn(`${STASH_NAME}: a stash bag can't be put inside a stash.`);
      return false;
    }
  });

  // One bag per stash per character; and the stash actor itself doesn't need any.
  Hooks.on("dnd5e.dropCreateItems", (sheet, items) => {
    const actor = sheet.inventorySource ?? sheet.actor;
    if ( !actor || !Array.isArray(items) ) return;
    const carried = new Set(getProxies(actor).map(p => stashForProxy(p)?.id));
    for ( let i = items.length - 1; i >= 0; i-- ) {
      const item = items[i];
      if ( !isProxy(item) && !isStash(item) ) continue;
      if ( isStashActor(actor) ) {
        ui.notifications.warn(`${STASH_NAME}: a stash bag can't be put inside a stash.`);
        items.splice(i, 1);
      } else if ( isStash(item) ) {
        // A real stash should never leave the stash actor.
        items.splice(i, 1);
      } else {
        const sid = stashForProxy(item)?.id;
        if ( carried.has(sid) && (item.parent !== actor) ) {
          ui.notifications.info(`${STASH_NAME}: ${actor.name} already carries "${item.name}".`);
          items.splice(i, 1);
        } else carried.add(sid);
      }
    }
  });
}
