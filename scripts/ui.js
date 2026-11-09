import { MODULE_ID, STASH_NAME } from "./constants.js";
import {
  FLAGS, TAB_ALL, TAB_UNSORTED, addTab, countTabs, escapeHTML, moveTab, removeTab, renameTab, setTabKeywords, showsOnTab
} from "./logic.js";
import {
  canManage, getActiveTab, getProxies, getStashConfig, isProxy, isStash, isStashActor, saveTabs, setActiveTab,
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

/* ---------- Small in-window editors ---------- */

/** Stop key presses and changes in our inputs reaching the sheet (so Enter doesn't submit it). */
function isolate(input) {
  for ( const type of ["change", "input", "keyup", "keypress"] ) input.addEventListener(type, ev => ev.stopPropagation());
}

/**
 * Show a text box in the tab bar. Enter or clicking away saves; Escape cancels.
 * @param {HTMLElement} target   The tab to replace, or the element to put the new box in front of.
 * @param {object} opts
 * @param {boolean} [opts.replace]  Replace `target` (rename) instead of inserting before it (new tab).
 */
function inlineTabInput(target, { value="", placeholder="", replace=false, onCommit }) {
  const wrap = document.createElement("div");
  wrap.className = "ah-stash-tab active ah-tab-editing";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "ah-tab-input";
  input.value = value;
  input.placeholder = placeholder;
  input.setAttribute("aria-label", placeholder || "Tab name");
  wrap.append(input);
  isolate(input);

  const original = replace ? target : null;
  if ( replace ) target.replaceWith(wrap);
  else target.before(wrap);
  // The tab that was active stops looking active while typing.
  wrap.parentElement?.querySelectorAll(".ah-stash-tab.active").forEach(t => { if ( t !== wrap ) t.classList.remove("active"); });

  let done = false;
  const finish = async save => {
    if ( done ) return;
    done = true;
    const text = input.value.trim();
    if ( save && text && (text !== value) ) {
      input.disabled = true;
      await onCommit(text);   // Saving redraws the window, which rebuilds the tab bar.
      // If it didn't save (e.g. no permission), tidy up the box.
      if ( wrap.isConnected ) {
        if ( original ) wrap.replaceWith(original);
        else wrap.remove();
      }
    } else {
      if ( original ) wrap.replaceWith(original);
      else wrap.remove();
      wrap.dispatchEvent(new CustomEvent("ah-cancel", { bubbles: true }));
    }
  };
  input.addEventListener("keydown", ev => {
    ev.stopPropagation();
    if ( ev.key === "Enter" ) { ev.preventDefault(); finish(true); }
    else if ( ev.key === "Escape" ) { ev.preventDefault(); finish(false); }
  });
  input.addEventListener("blur", () => finish(true));
  input.focus();
  input.select();
  return wrap;
}

/** Close any open tab menu or popover. */
function closeFloating() {
  document.querySelectorAll(".ah-tab-menu, .ah-tab-popover").forEach(el => el.remove());
}

/** Place a floating box under a tab, kept on screen. */
function placeUnder(box, anchor) {
  document.body.append(box);
  const r = anchor.getBoundingClientRect();
  const w = box.offsetWidth;
  box.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - w - 4))}px`;
  box.style.top = `${r.bottom + 4}px`;
}

/** Close floating boxes when clicking elsewhere or pressing Escape. */
function closeOnOutside(box) {
  const away = ev => {
    if ( box.contains(ev.target) ) return;
    box.remove();
    cleanup();
  };
  const esc = ev => { if ( ev.key === "Escape" ) { box.remove(); cleanup(); } };
  const cleanup = () => {
    document.removeEventListener("pointerdown", away, true);
    document.removeEventListener("keydown", esc, true);
  };
  setTimeout(() => {
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", esc, true);
  }, 0);
}

/** A small box under a tab for editing its keywords. */
function keywordsPopover(anchor, stash, category, accent) {
  closeFloating();
  const box = document.createElement("div");
  box.className = "ah-tab-popover";
  box.style.setProperty("--ah-accent", accent);
  box.innerHTML = `
    <label>Keywords for <strong>${escapeHTML(category.name)}</strong></label>
    <input type="text" value="${escapeHTML(category.keywords.join(", "))}" placeholder="Keywords, separated, by, commas">
    <p class="ah-hint">Saved with the tab, ready for automatic sorting in a future update.</p>
    <div class="ah-popover-buttons">
      <button type="button" data-do="save"><i class="fa-solid fa-check"></i> Save</button>
      <button type="button" data-do="cancel"><i class="fa-solid fa-xmark"></i> Cancel</button>
    </div>`;
  placeUnder(box, anchor);
  closeOnOutside(box);
  const input = box.querySelector("input");
  const save = async () => {
    box.remove();
    await saveTabs(stash, setTabKeywords(getStashConfig(stash).categories, category.id, input.value));
  };
  input.addEventListener("keydown", ev => {
    if ( ev.key === "Enter" ) { ev.preventDefault(); save(); }
    if ( ev.key === "Escape" ) { ev.preventDefault(); box.remove(); }
  });
  box.querySelector('[data-do="save"]').addEventListener("click", save);
  box.querySelector('[data-do="cancel"]').addEventListener("click", () => box.remove());
  input.focus();
  input.select();
}

/** Right-click menu for a tab. */
function tabMenu(event, btn, stash, accent) {
  event.preventDefault();
  event.stopPropagation();
  closeFloating();
  const { categories } = getStashConfig(stash);
  const index = categories.findIndex(c => c.id === btn.dataset.tabId);
  const category = categories[index];
  if ( !category ) return;

  const entries = [
    { icon: "fa-pen", label: "Rename", run: () => renameInline(btn, stash, category) },
    { icon: "fa-tags", label: "Keywords…", run: () => keywordsPopover(btn, stash, category, accent) },
    { icon: "fa-arrow-left", label: "Move left", disabled: index === 0,
      run: () => saveTabs(stash, moveTab(categories, category.id, -1)) },
    { icon: "fa-arrow-right", label: "Move right", disabled: index === categories.length - 1,
      run: () => saveTabs(stash, moveTab(categories, category.id, 1)) },
    { icon: "fa-trash", label: "Delete tab", danger: true, run: async () => {
      if ( getActiveTab(stash.id) === category.id ) setActiveTab(stash.id, TAB_ALL);
      await saveTabs(stash, removeTab(categories, category.id));
      ui.notifications.info(`${STASH_NAME}: removed the "${category.name}" tab. Its items are now under Unsorted.`);
    } }
  ];

  const menu = document.createElement("div");
  menu.className = "ah-tab-menu";
  menu.style.setProperty("--ah-accent", accent);
  menu.innerHTML = entries.map((e, i) => `
    <button type="button" data-i="${i}" class="${e.danger ? "ah-danger" : ""}" ${e.disabled ? "disabled" : ""}>
      <i class="fa-solid ${e.icon}"></i> ${e.label}
    </button>`).join("");
  menu.querySelectorAll("button").forEach(b => b.addEventListener("click", () => {
    menu.remove();
    entries[Number(b.dataset.i)].run();
  }));
  placeUnder(menu, btn);
  closeOnOutside(menu);
}

function renameInline(btn, stash, category) {
  closeFloating();
  inlineTabInput(btn, {
    value: category.name,
    placeholder: "Tab name",
    replace: true,
    onCommit: name => saveTabs(stash, renameTab(getStashConfig(stash).categories, category.id, name))
  });
}

/* ---------- The tab bar ---------- */

function addTabs(app, root, stash) {
  root.querySelectorAll(".ah-stash-tabs").forEach(el => el.remove());
  const inventory = root.querySelector("dnd5e-inventory, .inventory-element");
  if ( !inventory ) return;

  const { categories, accent } = getStashConfig(stash);
  const manage = canManage();
  let active = getActiveTab(stash.id);
  if ( (active !== TAB_ALL) && (active !== TAB_UNSORTED) && !categories.some(c => c.id === active) ) {
    active = TAB_ALL;
    setActiveTab(stash.id, TAB_ALL);
  }
  if ( !categories.length && (active === TAB_UNSORTED) ) setActiveTab(stash.id, active = TAB_ALL);

  const contents = stash.actor.items.filter(i => i._source.system?.container === stash.id);
  const counts = countTabs(contents.map(i => i.getFlag(MODULE_ID, FLAGS.CATEGORY) ?? null), categories);

  const tabs = [{ id: TAB_ALL, name: "All", icon: "fa-solid fa-layer-group" }];
  for ( const c of categories ) tabs.push({ id: c.id, name: c.name, keywords: c.keywords, custom: true });
  if ( categories.length ) tabs.push({ id: TAB_UNSORTED, name: "Unsorted", icon: "fa-solid fa-inbox" });

  const nav = document.createElement("nav");
  nav.className = "ah-stash-tabs";
  nav.innerHTML = tabs.map(t => {
    const tips = [];
    if ( t.id === TAB_ALL ) tips.push("Everything in this stash");
    if ( t.id === TAB_UNSORTED ) tips.push("Items not on any tab");
    if ( t.keywords?.length ) tips.push(`Keywords: ${t.keywords.join(", ")}`);
    if ( t.custom && manage ) tips.push("Double-click to rename, right-click for more");
    return `<button type="button" class="ah-stash-tab ${t.id === active ? "active" : ""}" data-tab-id="${escapeHTML(t.id)}"
      ${tips.length ? `data-tooltip="${escapeHTML(tips.join("<br>"))}"` : ""}>
      ${t.icon ? `<i class="${t.icon}"></i>` : ""}<span class="ah-tab-name">${escapeHTML(t.name)}</span>
      <span class="ah-tab-count">${counts[t.id] ?? 0}</span>
    </button>`;
  }).join("") + (manage ? `<button type="button" class="ah-stash-tab ah-tab-add" data-tooltip="New tab"><i class="fa-solid fa-plus"></i></button>` : "");

  for ( const btn of nav.querySelectorAll(".ah-stash-tab[data-tab-id]") ) {
    const tabId = btn.dataset.tabId;
    const category = categories.find(c => c.id === tabId);
    btn.addEventListener("click", event => {
      event.preventDefault();
      setActiveTab(stash.id, tabId);
      nav.querySelectorAll(".ah-stash-tab").forEach(b => b.classList.toggle("active", b === btn));
      applyFilter(root, stash);
    });

    // Your own tabs: double-click to rename, right-click for the menu.
    if ( category && manage ) {
      btn.addEventListener("dblclick", event => {
        event.preventDefault();
        renameInline(btn, stash, category);
      });
      btn.addEventListener("contextmenu", event => tabMenu(event, btn, stash, accent));
    }

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
      const cat = ((tabId === TAB_ALL) || (tabId === TAB_UNSORTED)) ? null : tabId;
      await setItemCategory(item, stash, cat);
    });
  }

  // "+": a new tab appears right there, ready to type its name.
  const add = nav.querySelector(".ah-tab-add");
  add?.addEventListener("click", event => {
    event.preventDefault();
    if ( nav.querySelector(".ah-tab-editing") ) return nav.querySelector(".ah-tab-input")?.focus();
    closeFloating();
    // New tabs go after the existing ones (before "Unsorted").
    const before = nav.querySelector(`.ah-stash-tab[data-tab-id="${TAB_UNSORTED}"]`) ?? add;
    const editor = inlineTabInput(before, {
      placeholder: "New tab name",
      onCommit: async name => {
        const id = foundry.utils.randomID(8);
        setActiveTab(stash.id, id);
        await saveTabs(stash, addTab(getStashConfig(stash).categories, name, id));
      }
    });
    // If cancelled, put the "active" look back on the open tab.
    editor.addEventListener("ah-cancel", () => {
      nav.querySelector(`.ah-stash-tab[data-tab-id="${getActiveTab(stash.id)}"]`)?.classList.add("active");
    });
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

