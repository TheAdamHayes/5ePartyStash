/**
 * Pure helper logic with no Foundry dependencies, so it can be tested in Node.
 */

/** Flag names stored under flags["ah-5e-party-stash"]. */
export const FLAGS = Object.freeze({
  STASH_ACTOR: "stashActor",   // The hidden-in-plain-sight actor that really holds the items
  STASH: "stash",              // The real container item on that actor
  PROXY: "proxy",              // A "Shared Party Stash" bag that players carry (a key, holds nothing)
  TEMPLATE: "template"         // The world item in the Items sidebar players drag into their inventory
});

/**
 * Decide the drag/drop behaviour when an item moves between actors.
 * Moving an item out of (or into) the party stash should always MOVE it, never duplicate it.
 *
 * @param {object} o
 * @param {string} o.result        Behaviour dnd5e picked on its own ("copy", "move", "link", "none").
 * @param {boolean} o.isItem       Whether the thing being dragged is an Item.
 * @param {string|null} o.sourceActorId  Actor the dragged item currently belongs to (null for sidebar/compendium).
 * @param {string|null} o.targetActorId  Actor the item is being dropped on.
 * @param {string|null} o.stashActorId   The party stash actor's id.
 * @param {boolean} o.isGM         Whether the current user is a GM.
 * @param {boolean} o.copyKey      Whether the copy modifier key (Ctrl/Alt) is held.
 * @returns {string}
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

/**
 * Data that keeps a stash bag (real or proxy) weightless and unlimited.
 * @returns {object}
 */
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
 * @param {object} flatChanges  Flattened update data.
 * @returns {object}
 */
export function sanitizeBagChanges(flatChanges) {
  for ( const [key, value] of Object.entries(weightlessSystemData()) ) {
    if ( key in flatChanges ) flatChanges[key] = value;
  }
  // Catch nested updates like { "system.weight": { value: 5 } } or { "system.capacity": {...} }
  if ( flatChanges["system.weight"] && (typeof flatChanges["system.weight"] === "object") ) {
    flatChanges["system.weight"].value = 0;
  }
  if ( flatChanges["system.capacity"] && (typeof flatChanges["system.capacity"] === "object") ) {
    delete flatChanges["system.capacity"];
  }
  for ( const key of Object.keys(flatChanges) ) {
    if ( key.startsWith("system.capacity.") && !(key in weightlessSystemData()) ) delete flatChanges[key];
  }
  // Keep the "weightless contents" property switched on
  const props = flatChanges["system.properties"];
  if ( Array.isArray(props) && !props.includes("weightlessContents") ) props.push("weightlessContents");
  if ( flatChanges["system.properties.-=weightlessContents"] !== undefined ) {
    delete flatChanges["system.properties.-=weightlessContents"];
  }
  return flatChanges;
}

/**
 * Work out which loose items on the stash actor should be put back into the stash container
 * (e.g. if a GM deleted the stash bag without deleting its contents).
 * @param {object[]} items          Plain objects: { id, container, flags, physical }.
 * @param {string} stashContainerId
 * @param {string} moduleId
 * @returns {string[]}  Item ids to move into the stash container.
 */
export function findLooseItems(items, stashContainerId, moduleId) {
  const ids = new Set(items.map(i => i.id));
  return items.filter(i => {
    if ( !i.physical || (i.id === stashContainerId) ) return false;
    if ( i.flags?.[moduleId]?.[FLAGS.STASH] ) return false;
    // Top-level, or pointing at a container that no longer exists
    return !i.container || !ids.has(i.container);
  }).map(i => i.id);
}
