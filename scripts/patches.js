import { MODULE_ID, STASH_NAME, TEMPLATE_NAME } from "./constants.js";
import { decideDropBehavior, sanitizeBagChanges, weightlessSystemData } from "./logic.js";
import {
  ensureStash, getStashActor, getStashContainer, getProxies, isProxy, isStash, isStashActor, openStash,
  transferToStash
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
      <p><strong>This is your Shared Party Stash bag.</strong></p>
      <p>Removing it from your inventory will <strong>not</strong> delete or lose any items. Everything stays
      safely in the party stash for the rest of the group.</p>
      <p>To get access back later, drag the <em>${TEMPLATE_NAME}</em> item from the Items sidebar into your
      inventory again.</p>
      <p>Remove the stash bag from your inventory?</p>`,
    yes: { label: "Remove Bag", icon: "fa-solid fa-trash" },
    no: { label: "Keep It", icon: "fa-solid fa-xmark", default: true },
    rejectClose: false
  });
  if ( yes ) return item.delete(operation);
  return null;
}

async function confirmStashDeletion(item, operation={}) {
  if ( !game.user.isGM ) {
    ui.notifications.warn(`${STASH_NAME}: only the GM can delete the party stash itself.`);
    return null;
  }
  const count = (await item.system.contentsCount) ?? 0;
  const yes = await DialogV2.confirm({
    window: { title: `Delete the ${STASH_NAME}?`, icon: "fa-solid fa-triangle-exclamation" },
    position: { width: 460 },
    content: `
      <p><strong>Warning:</strong> this is the real party stash, holding ${count} item(s).</p>
      <p>If you delete it, the items inside are kept on the "${STASH_NAME}" actor and a fresh stash bag is
      made for them straight away. Are you sure?</p>`,
    yes: { label: "Delete Stash Bag", icon: "fa-solid fa-trash" },
    no: { label: "Cancel", default: true },
    rejectClose: false
  });
  if ( yes ) return item.delete({ ...operation, deleteContents: false, [MODULE_ID]: { confirmed: true } });
  return null;
}

async function confirmStashActorDeletion(actor) {
  const count = getStashContainer() ? ((await getStashContainer().system.contentsCount) ?? 0) : actor.items.size;
  const yes = await DialogV2.confirm({
    window: { title: `Delete the ${STASH_NAME} actor?`, icon: "fa-solid fa-triangle-exclamation" },
    position: { width: 460 },
    content: `
      <p><strong>Warning:</strong> the "${actor.name}" actor holds every item in the party stash
      (${count} item(s)). Deleting it destroys all of them for good.</p>
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

    // Dropping an item onto the Shared Party Stash bag icon puts it in the real shared stash.
    const originalDropContainer = BaseActorSheet.prototype._onDropItemContainer;
    if ( typeof originalDropContainer === "function" ) {
      BaseActorSheet.prototype._onDropItemContainer = async function(event, item, container) {
        if ( isProxy(container) ) {
          if ( isStashActor(item?.actor) ) return; // already in the stash
          return transferToStash(item);
        }
        return originalDropContainer.call(this, event, item, container);
      };
    }
  } else {
    console.warn(`${MODULE_ID} | dnd5e BaseActorSheet not found; drag-and-drop moving may fall back to copying.`);
  }

  if ( ContainerSheet ) {
    wrapDropBehavior(ContainerSheet.prototype, function() { return this.item?.actor; });

    // Opening any Shared Party Stash bag opens the real shared stash instead.
    const originalRender = ContainerSheet.prototype.render;
    ContainerSheet.prototype.render = function(options, ...rest) {
      if ( isProxy(this.item) ) {
        const force = (typeof options === "boolean") ? options : options?.force;
        if ( force ) openStash();
        return this;
      }
      return originalRender.call(this, options, ...rest);
    };
  }

  // Confirmation before throwing away the stash bag (or the real stash).
  const originalDeleteDialog = Item5e.prototype.deleteDialog;
  Item5e.prototype.deleteDialog = async function(dialogOptions={}, operation={}) {
    if ( isStash(this) ) return confirmStashDeletion(this, operation);
    if ( isProxy(this) && this.parent ) return confirmProxyRemoval(this, operation);
    return originalDeleteDialog.call(this, dialogOptions, operation);
  };
}

/* -------------------------------------------- */
/*  Document hooks                              */
/* -------------------------------------------- */

export function registerHooks() {
  // Keep stash bags weightless and stop a bag being created somewhere it shouldn't be.
  Hooks.on("preCreateItem", (item, data, options, userId) => {
    if ( userId !== game.user.id ) return;
    const parent = item.parent;

    if ( isProxy(item) && parent ) {
      if ( isStashActor(parent) ) {
        ui.notifications.warn(`${STASH_NAME}: the stash bag can't be put inside the stash.`);
        return false;
      }
      item.updateSource(weightlessSystemData());
      return;
    }

    // Something being created directly inside a player's Shared Party Stash bag: send it to the real stash.
    const containerId = foundry.utils.getProperty(data, "system.container");
    const target = containerId ? parent?.items.get(containerId) : null;
    if ( isProxy(target) ) {
      const stash = getStashContainer();
      const stashActor = getStashActor();
      if ( !stash || !stashActor ) return false;
      const createData = foundry.utils.deepClone(data);
      delete createData._id;
      foundry.utils.setProperty(createData, "system.container", stash.id);
      stashActor.createEmbeddedDocuments("Item", [createData]);
      return false;
    }
  });

  Hooks.on("preUpdateItem", (item, changes, options, userId) => {
    if ( userId !== game.user.id ) return;

    // Stash bags always weigh nothing and have no limit.
    if ( isProxy(item) || isStash(item) ) {
      const flat = foundry.utils.flattenObject(changes);
      const touchesBag = Object.keys(flat).some(k => /^system\.(weight|capacity|quantity|properties|identified)/.test(k));
      if ( touchesBag ) {
        sanitizeBagChanges(flat);
        for ( const key of Object.keys(changes) ) delete changes[key];
        Object.assign(changes, foundry.utils.expandObject(flat));
      }
    }

    // Moving an item into a player's Shared Party Stash bag: send it to the real stash instead.
    const containerId = foundry.utils.getProperty(changes, "system.container");
    if ( containerId && item.parent ) {
      const target = item.parent.items.get(containerId);
      if ( isProxy(target) ) {
        transferToStash(item);
        return false;
      }
    }
  });

  // Never lose the real stash by accident.
  Hooks.on("preDeleteItem", (item, options, userId) => {
    if ( !isStash(item) || options?.[MODULE_ID]?.confirmed ) return;
    if ( userId === game.user.id ) confirmStashDeletion(item);
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

  // If the GM does delete the stash bag or actor, rebuild it straight away (keeping any items left behind).
  Hooks.on("deleteItem", (item, options, userId) => {
    if ( isStash(item) && game.user.isGM && (userId === game.user.id) ) ensureStash();
  });
  Hooks.on("deleteActor", (actor, options, userId) => {
    if ( isStashActor(actor) && game.user.isGM && (userId === game.user.id) ) ensureStash();
  });

  // Don't put the stash bag inside a stash.
  Hooks.on("dnd5e.dropItemSheetData", (container, sheet, data) => {
    if ( !(isStash(container) || isProxy(container)) || (data?.type !== "Item") || !data.uuid ) return;
    const dropped = fromUuidSync(data.uuid);
    if ( isProxy(dropped) || isStash(dropped) ) {
      ui.notifications.warn(`${STASH_NAME}: the stash bag can't be put inside the stash.`);
      return false;
    }
  });

  // One stash bag per character is enough; and the stash actor itself doesn't need one.
  Hooks.on("dnd5e.dropCreateItems", (sheet, items) => {
    const actor = sheet.inventorySource ?? sheet.actor;
    if ( !actor || !Array.isArray(items) ) return;
    const hasOne = getProxies(actor).length > 0;
    for ( let i = items.length - 1; i >= 0; i-- ) {
      const item = items[i];
      if ( !isProxy(item) && !isStash(item) ) continue;
      if ( isStashActor(actor) ) {
        ui.notifications.warn(`${STASH_NAME}: the stash bag can't be put inside the stash.`);
        items.splice(i, 1);
      } else if ( isStash(item) ) {
        // The real stash should never leave the stash actor.
        items.splice(i, 1);
      } else if ( hasOne && (item.parent !== actor) ) {
        ui.notifications.info(`${STASH_NAME}: ${actor.name} already carries the Shared Party Stash.`);
        items.splice(i, 1);
      }
    }
  });
}
