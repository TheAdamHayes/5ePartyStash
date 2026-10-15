import { STASH_NAME } from "./constants.js";
import { getIcon, getProxies, isStashActor, openStash, transferToStash } from "./stash.js";

/** Add the "Party Stash" button next to the bag icons, and mark the shared bag so it stands out. */
export function decorateActorSheet(app, element) {
  const actor = app?.actor;
  const root = (element instanceof HTMLElement) ? element : element?.[0];
  if ( !actor || !root || isStashActor(actor) ) return;

  const proxies = getProxies(actor);

  // Mark every Shared Party Stash bag (tile and inventory row) with a "shared" badge.
  for ( const proxy of proxies ) {
    for ( const el of root.querySelectorAll(`[data-item-id="${proxy.id}"]`) ) {
      el.classList.add("ah-party-stash-proxy");
      if ( el.matches(".container") && !el.querySelector(".ah-party-stash-badge") ) {
        const badge = document.createElement("i");
        badge.className = "ah-party-stash-badge fa-solid fa-users";
        badge.dataset.tooltip = "Shared with the party";
        el.querySelector("a")?.append(badge);
      }
      const title = el.querySelector(".item-name .title");
      if ( title && !title.querySelector(".ah-party-stash-tag") ) {
        const tag = document.createElement("span");
        tag.className = "ah-party-stash-tag";
        tag.innerHTML = '<i class="fa-solid fa-users"></i> Shared';
        title.append(tag);
      }
    }
  }

  // The button itself, shown next to the bag icons whenever this character carries the stash bag.
  for ( const list of root.querySelectorAll("ul.containers") ) {
    const existing = list.querySelector(".ah-party-stash-open");
    if ( !proxies.length ) {
      existing?.remove();
      continue;
    }
    if ( existing ) continue;

    const li = document.createElement("li");
    li.className = "container ah-party-stash-open";
    li.innerHTML = `
      <a role="button" aria-label="Open ${STASH_NAME}" data-tooltip="Open the ${STASH_NAME} (drop items here to stash them)">
        <img src="${getIcon()}" alt="${STASH_NAME}" draggable="false">
        <span class="ah-party-stash-label"><i class="fa-solid fa-users"></i> Party</span>
      </a>`;

    li.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      openStash();
    });

    // Drop an item on the button to send it to the stash.
    li.addEventListener("dragover", event => {
      event.preventDefault();
      event.stopPropagation();
      if ( event.dataTransfer ) event.dataTransfer.dropEffect = "move";
      li.classList.add("ah-drop-hover");
    });
    li.addEventListener("dragleave", () => li.classList.remove("ah-drop-hover"));
    li.addEventListener("drop", async event => {
      event.preventDefault();
      event.stopPropagation();
      li.classList.remove("ah-drop-hover");
      let data;
      try {
        data = foundry.applications.ux.TextEditor.implementation.getDragEventData(event);
      } catch { return; }
      if ( data?.type !== "Item" || !data.uuid ) return;
      const item = await fromUuid(data.uuid);
      if ( item ) await transferToStash(item);
    });

    list.append(li);
  }
}

export function registerUI() {
  Hooks.on("renderBaseActorSheet", decorateActorSheet);
}

