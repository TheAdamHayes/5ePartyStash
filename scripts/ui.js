import { MODULE_ID } from "./constants.js";
import { FLAGS, TAB_ALL, TAB_UNSORTED, countTabs, escapeHTML, showsOnTab } from "./logic.js";
import {
  canManage, getActiveTab, getProxies, getStashConfig, isProxy, isStash, isStashActor, setActiveTab,
  setItemCategory, stashForProxy
} from "./stash.js";
import { openEditor, refreshOverviews } from "./apps.js";

/* -------------------------------------------- */
/*  Character sheets: the stash bag icons       */
/* -------------------------------------------- */

/** Mark each stash bag a character carries so it stands out, using that stash's picture, name and colour. */
export function decorateActorSheet(app, element) {
  const actor = app?.actor;
  const root = (element instanceof HTMLElement) ? element : element?.[0];
  if ( !actor || !root || isStashActor(actor) ) return;

  for ( const proxy of getProxies(actor) ) {
    const stash = stashForProxy(proxy);
    const accent = getStashConfig(stash).accent;
    const name = stash?.name ?? proxy.name;
    for ( const el of root.querySelectorAll(`[data-item-id="${proxy.id}"]`) ) {
      el.classList.add("ah-party-stash-proxy");
      el.style.setProperty("--ah-accent", accent);

      // The bag icon next to the encumbrance bar: live picture and a name label.
      if ( el.matches(".container") ) {
        const link = el.querySelector("a") ?? el;
        const img = el.querySelector("img");
        if ( img && stash?.img ) img.src = stash.img;
        link.dataset.tooltip = `Open ${escapeHTML(name)} (drop items here to stash them)`;
        let label = link.querySelector(".ah-party-stash-label");
        if ( !label ) {
          label = document.createElement("span");
          label.className = "ah-party-stash-label";
          link.append(label);
        }
        label.textContent = name;
      }

      // The bag's row in the inventory list: a "Shared" tag after its name.
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

/* -------------------------------------------- */
/*  Stash windows: wrench, tabs, accent colour  */
/* -------------------------------------------- */

/** Read a dragged item from a drop event. */
async function droppedItem(event) {
  let data;
  try {
    data = foundry.applications.ux.TextEditor.implementation.getDragEventData(event);
  } catch {
    return null;
  }
  if ( (data?.type !== "Item") || !data.uuid ) return null;
  return fromUuid(data.uuid);
}

function addWrench(app, root, stash) {
  const header = app.window?.header ?? root.querySelector(".window-header");
  if ( !header ) return;
  let wrench = header.querySelector(".ah-stash-wrench");
  if ( !canManage() ) {
    wrench?.remove();
    return;
  }
  if ( wrench ) return;
  wrench = document.createElement("button");
  wrench.type = "button";
  wrench.className = "header-control icon fa-solid fa-wrench ah-stash-wrench";
  wrench.dataset.tooltip = "Edit stash: name, icon, colour and tabs";
  wrench.setAttribute("aria-label", "Edit stash");
  wrench.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    openEditor(app.item);
  });
  const before = header.querySelector('[data-action="toggleControls"]') ?? header.querySelector('[data-action="close"]');
  if ( before ) before.before(wrench);
  else header.append(wrench);
}

/** Show only the rows on the open tab. */
function applyFilter(root, stash) {
  const inventory = root.querySelector("dnd5e-inventory, .inventory-element");
  if ( !inventory ) return;
  const { categories } = getStashConfig(stash);
  const active = getActiveTab(stash.id);
  inventory.classList.toggle("ah-cat-filtering", active !== TAB_ALL);
  for ( const row of inventory.querySelectorAll("li.item[data-item-id]") ) {
    const item = stash.actor.items.get(row.dataset.itemId);
    const cat = item?.getFlag(MODULE_ID, FLAGS.CATEGORY) ?? null;
    row.classList.toggle("ah-cat-hidden", !showsOnTab(active, cat, categories));
  }
}

function addTabs(app, root, stash) {
  root.querySelectorAll(".ah-stash-tabs").forEach(el => el.remove());
  const inventory = root.querySelector("dnd5e-inventory, .inventory-element");
  if ( !inventory ) return;

  const { categories } = getStashConfig(stash);
  let active = getActiveTab(stash.id);
  if ( (active !== TAB_ALL) && (active !== TAB_UNSORTED) && !categories.some(c => c.id === active) ) {
    active = TAB_ALL;
    setActiveTab(stash.id, TAB_ALL);
  }
  if ( !categories.length && (active === TAB_UNSORTED) ) setActiveTab(stash.id, active = TAB_ALL);

  const contents = stash.actor.items.filter(i => i._source.system?.container === stash.id);
  const counts = countTabs(contents.map(i => i.getFlag(MODULE_ID, FLAGS.CATEGORY) ?? null), categories);

  const tabs = [{ id: TAB_ALL, name: "All", icon: "fa-solid fa-layer-group" }];
  for ( const c of categories ) tabs.push({ id: c.id, name: c.name, keywords: c.keywords });
  if ( categories.length ) tabs.push({ id: TAB_UNSORTED, name: "Unsorted", icon: "fa-solid fa-inbox" });

  const nav = document.createElement("nav");
  nav.className = "ah-stash-tabs";
  nav.innerHTML = tabs.map(t => {
    const tip = t.keywords?.length ? `Keywords: ${t.keywords.join(", ")}` : (t.id === TAB_ALL ? "Everything in this stash" : (t.id === TAB_UNSORTED ? "Items not on any tab" : ""));
    return `<button type="button" class="ah-stash-tab ${t.id === active ? "active" : ""}" data-tab-id="${escapeHTML(t.id)}"
      ${tip ? `data-tooltip="${escapeHTML(tip)}"` : ""}>
      ${t.icon ? `<i class="${t.icon}"></i>` : ""}<span class="ah-tab-name">${escapeHTML(t.name)}</span>
      <span class="ah-tab-count">${counts[t.id] ?? 0}</span>
    </button>`;
  }).join("") + (canManage() ? `<button type="button" class="ah-stash-tab ah-tab-edit" data-tooltip="Add or edit tabs"><i class="fa-solid fa-plus"></i></button>` : "");

  for ( const btn of nav.querySelectorAll(".ah-stash-tab[data-tab-id]") ) {
    const tabId = btn.dataset.tabId;
    btn.addEventListener("click", event => {
      event.preventDefault();
      setActiveTab(stash.id, tabId);
      nav.querySelectorAll(".ah-stash-tab").forEach(b => b.classList.toggle("active", b === btn));
      applyFilter(root, stash);
    });

    // Drag an item onto a tab to put it on that tab.
    btn.addEventListener("dragover", event => {
      event.preventDefault();
      event.stopPropagation();
      btn.classList.add("ah-drop-hover");
    });
    btn.addEventListener("dragleave", () => btn.classList.remove("ah-drop-hover"));
    btn.addEventListener("drop", async event => {
      event.preventDefault();
      event.stopPropagation();
      btn.classList.remove("ah-drop-hover");
      const item = await droppedItem(event);
      if ( !item || isStash(item) || isProxy(item) ) return;
      // "All" and "Unsorted" mean "no tab". Dropping on "All" something already in this stash changes nothing.
      if ( (tabId === TAB_ALL) && (item.actor === stash.actor) && (item._source.system?.container === stash.id) ) return;
      const category = ((tabId === TAB_ALL) || (tabId === TAB_UNSORTED)) ? null : tabId;
      await setItemCategory(item, stash, category);
    });
  }
  nav.querySelector(".ah-tab-edit")?.addEventListener("click", event => {
    event.preventDefault();
    openEditor(stash);
  });

  inventory.before(nav);
  applyFilter(root, stash);
}

export function decorateStashSheet(app, element) {
  const stash = app?.item;
  if ( !isStash(stash) ) return;
  const root = (element instanceof HTMLElement) ? element : element?.[0];
  if ( !root ) return;
  const { accent } = getStashConfig(stash);
  root.classList.add("ah-party-stash-sheet");
  root.style.setProperty("--ah-accent", accent);
  addWrench(app, root, stash);
  addTabs(app, root, stash);
}

/* -------------------------------------------- */

export function registerUI() {
  Hooks.on("renderBaseActorSheet", decorateActorSheet);
  Hooks.on("renderContainerSheet", decorateStashSheet);

  // Keep the overview window up to date.
  const refresh = item => { if ( isStash(item) || isProxy(item) ) refreshOverviews(); };
  Hooks.on("createItem", refresh);
  Hooks.on("updateItem", refresh);
  Hooks.on("deleteItem", refresh);

  // Changes to a stash's tabs or colour redraw open character sheets that carry its bag.
  Hooks.on("updateItem", (item, changes) => {
    if ( !isStash(item) ) return;
    for ( const a of game.actors ) {
      if ( a.sheet?.rendered && getProxies(a).some(p => stashForProxy(p)?.id === item.id) ) a.sheet.render();
    }
  });
}

