import { STASH_NAME } from "./constants.js";
import { getProxies, isStashActor } from "./stash.js";

/**
 * Mark the Shared Party Stash bag so it stands out from ordinary bags.
 * Clicking the bag opens the shared stash, and dropping items on it sends them to the stash
 * (both handled in patches.js), so no separate button is needed.
 */
export function decorateActorSheet(app, element) {
  const actor = app?.actor;
  const root = (element instanceof HTMLElement) ? element : element?.[0];
  if ( !actor || !root || isStashActor(actor) ) return;

  for ( const proxy of getProxies(actor) ) {
    for ( const el of root.querySelectorAll(`[data-item-id="${proxy.id}"]`) ) {
      el.classList.add("ah-party-stash-proxy");

      // The bag icon next to the encumbrance bar: add a "PARTY" label.
      if ( el.matches(".container") ) {
        const link = el.querySelector("a");
        if ( link && !link.querySelector(".ah-party-stash-label") ) {
          link.dataset.tooltip = `Open the ${STASH_NAME} (drop items here to stash them)`;
          const label = document.createElement("span");
          label.className = "ah-party-stash-label";
          label.innerHTML = '<i class="fa-solid fa-users"></i> Party';
          link.append(label);
        }
      }

      // The bag's row in the inventory list: add a "Shared" tag after its name.
      const title = el.querySelector(".item-name .title");
      if ( title && !title.querySelector(".ah-party-stash-tag") ) {
        const tag = document.createElement("span");
        tag.className = "ah-party-stash-tag";
        tag.innerHTML = '<i class="fa-solid fa-users"></i> Shared';
        title.append(tag);
      }
    }
  }
}

export function registerUI() {
  Hooks.on("renderBaseActorSheet", decorateActorSheet);
}
