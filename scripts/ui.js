import { MODULE_ID, STASH_NAME } from "./constants.js";
import {
  FLAGS, TAB_ALL, TAB_UNSORTED, addTab, escapeHTML, moveTab, removeTab, renameTab, reorderTab, setTabKeywords,
  showsOnTab, summarizeCounts
} from "./logic.js";
import {
  canManage, getActiveTab, getProxies, getStash, getStashConfig, getStashes, isPhysical, isProxy, isStash,
  isStashActor, saveTabs, setActiveTab, setItemCategory, stashCounts, stashForProxy, transferToStash
} from "./stash.js";
import { openEditor, refreshOverviews } from "./apps.js";

/** Custom drag type used when dragging a tab to reorder it (so it's never mistaken for an item). */
const TAB_DRAG = "application/x-ah-stash-tab";

/** Text safe for menus (strips anything that could be read as HTML). */
const plain = text => String(text ?? "").replace(/[<>]/g, "");

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
    const { accent, categories } = getStashConfig(stash);
    const name = stash?.name ?? proxy.name;
    const counts = stash ? stashCounts(stash) : null;
    for ( const el of root.querySelectorAll(`[data-item-id="${proxy.id}"]`) ) {
      el.classList.add("ah-party-stash-proxy");
      el.style.setProperty("--ah-accent", accent);

      // The bag icon next to the encumbrance bar: live picture, name label, item count and a summary tooltip.
      if ( el.matches(".container") ) {
        const link = el.querySelector("a") ?? el;
        const img = el.querySelector("img");
        if ( img && stash?.img ) img.src = stash.img;
        link.dataset.tooltip = `<strong>${escapeHTML(name)}</strong><br>${escapeHTML(summarizeCounts(counts, categories))}`
          + `<br><em>Click to open · drop items here to stash them</em>`;
        let label = link.querySelector(".ah-party-stash-label");
        if ( !label ) {
          label = document.createElement("span");
          label.className = "ah-party-stash-label";
          link.append(label);
        }
        label.textContent = name;
        let badge = link.querySelector(".ah-party-stash-count");
        if ( !badge ) {
          badge = document.createElement("span");
          badge.className = "ah-party-stash-count";
          link.append(badge);
        }
        badge.textContent = String(counts?.[TAB_ALL] ?? 0);
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
/*  Stash windows                               */
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

function addWrench(app, root) {
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

/* ---------- Undo bar ---------- */

/**
 * A small bar at the bottom of the stash window with an optional action button (e.g. Undo).
 * Disappears on its own after a few seconds.
 */
function showSnackbar(root, { message, actionLabel, onAction, accent, duration=7000 }) {
  root.querySelectorAll(".ah-snackbar").forEach(el => el.remove());
  const bar = document.createElement("div");
  bar.className = "ah-snackbar";
  bar.style.setProperty("--ah-accent", accent);
  bar.style.setProperty("--ah-snack-time", `${duration}ms`);
  bar.setAttribute("role", "status");
  bar.innerHTML = `<span class="ah-snack-text">${escapeHTML(message)}</span>`
    + (actionLabel ? `<button type="button" class="ah-snack-action">${escapeHTML(actionLabel)}</button>` : "")
    + `<button type="button" class="ah-snack-close" aria-label="Dismiss"><i class="fa-solid fa-xmark"></i></button>`
    + `<span class="ah-snack-timer"></span>`;
  const close = () => {
    bar.classList.add("ah-leaving");
    setTimeout(() => bar.remove(), 200);
  };
  bar.querySelector(".ah-snack-action")?.addEventListener("click", async ev => {
    ev.preventDefault();
    close();
    await onAction?.();
  });
  bar.querySelector(".ah-snack-close").addEventListener("click", ev => {
    ev.preventDefault();
    close();
  });
  root.append(bar);
  setTimeout(close, duration);
}

/* ---------- Filtering, row labels and empty state ---------- */

/** Show only the rows on the open tab, label rows with their tab, and show a hint when a tab is empty. */
function applyFilter(root, stash) {
  const inventory = root.querySelector("dnd5e-inventory, .inventory-element");
  if ( !inventory ) return;
  const { categories } = getStashConfig(stash);
  const byId = new Map(categories.map(c => [c.id, c]));
  const active = getActiveTab(stash.id);
  inventory.classList.toggle("ah-cat-filtering", active !== TAB_ALL);

  let shown = 0;
  for ( const row of inventory.querySelectorAll("li.item[data-item-id]") ) {
    const item = stash.actor.items.get(row.dataset.itemId);
    const cat = item?.getFlag(MODULE_ID, FLAGS.CATEGORY) ?? null;
    const visible = showsOnTab(active, cat, categories);
    row.classList.toggle("ah-cat-hidden", !visible);
    if ( visible && !row.hidden ) shown++;

    // On "All", a small label shows which tab each item is on.
    const title = row.querySelector(".item-name .title");
    row.querySelector(".ah-row-tab")?.remove();
    const tab = byId.get(cat);
    if ( title && tab && (active === TAB_ALL) ) {
      const pill = document.createElement("span");
      pill.className = "ah-row-tab";
      pill.textContent = tab.name;
      pill.dataset.tooltip = `On the "${escapeHTML(tab.name)}" tab`;
      title.append(pill);
    }
  }

  // Friendly message when the open tab has nothing on it.
  const list = inventory.querySelector(".items-list") ?? inventory;
  list.querySelector(".ah-empty")?.remove();
  if ( (active !== TAB_ALL) && !shown ) {
    const name = active === TAB_UNSORTED ? "Unsorted" : (byId.get(active)?.name ?? "this tab");
    const empty = document.createElement("div");
    empty.className = "ah-empty";
    empty.innerHTML = `<i class="fa-solid fa-box-open"></i>
      <strong>Nothing in ${escapeHTML(name)} yet</strong>
      <span>${active === TAB_UNSORTED
        ? "Every item in this stash is on a tab."
        : "Drop items into this window while this tab is open, or drag them onto the tab."}</span>`;
    list.append(empty);
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
  input.maxLength = 40;
  input.setAttribute("aria-label", placeholder || "Tab name");
  wrap.append(input);
  isolate(input);

  const original = replace ? target : null;
  if ( replace ) target.replaceWith(wrap);
  else target.before(wrap);
  wrap.parentElement?.querySelectorAll(".ah-stash-tab.active").forEach(t => { if ( t !== wrap ) t.classList.remove("active"); });
  wrap.scrollIntoView({ block: "nearest", inline: "nearest" });

  let done = false;
  const finish = async save => {
    if ( done ) return;
    done = true;
    const text = input.value.trim();
    if ( save && text && (text !== value) ) {
      input.disabled = true;
      await onCommit(text);   // Saving redraws the window, which rebuilds the tab bar.
      if ( wrap.isConnected ) {
        if ( original ) wrap.replaceWith(original);
        else wrap.remove();
      }
    } else {
      if ( original ) wrap.replaceWith(original);
      else wrap.remove();
      wrap.dispatchEvent(new CustomEvent("ah-cancel", { bubbles: true }));
      original?.focus();
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

/** Place a floating box under an element (or at the mouse), kept on screen. */
function placeFloating(box, anchor, event) {
  document.body.append(box);
  const w = box.offsetWidth;
  const h = box.offsetHeight;
  let x;
  let y;
  if ( event && (event.type === "contextmenu") && event.clientX ) {
    x = event.clientX;
    y = event.clientY + 2;
  } else {
    const r = anchor.getBoundingClientRect();
    x = r.left;
    y = r.bottom + 6;
  }
  box.style.left = `${Math.max(6, Math.min(x, window.innerWidth - w - 6))}px`;
  box.style.top = `${Math.max(6, Math.min(y, window.innerHeight - h - 6))}px`;
}

/** Close floating boxes when clicking elsewhere, pressing Escape, or scrolling the page. */
function closeOnOutside(box) {
  const away = ev => {
    if ( box.contains(ev.target) ) return;
    box.remove();
    cleanup();
  };
  const esc = ev => {
    if ( ev.key !== "Escape" ) return;
    ev.stopPropagation();
    box.remove();
    cleanup();
  };
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
    <label><i class="fa-solid fa-tags"></i> Keywords for <strong>${escapeHTML(category.name)}</strong></label>
    <input type="text" value="${escapeHTML(category.keywords.join(", "))}" placeholder="Keywords, separated, by, commas">
    <div class="ah-kw-preview"></div>
    <p class="ah-hint">Saved with the tab, ready for automatic sorting in a future update.</p>
    <div class="ah-popover-buttons">
      <button type="button" data-do="cancel">Cancel</button>
      <button type="button" data-do="save" class="ah-primary"><i class="fa-solid fa-check"></i> Save</button>
    </div>`;
  placeFloating(box, anchor);
  closeOnOutside(box);
  const input = box.querySelector("input");
  const preview = box.querySelector(".ah-kw-preview");
  const showChips = () => {
    const words = input.value.split(",").map(w => w.trim()).filter(Boolean);
    preview.innerHTML = words.map(w => `<span class="ah-chip">${escapeHTML(w)}</span>`).join("");
  };
  showChips();
  input.addEventListener("input", showChips);
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
  input.setSelectionRange(input.value.length, input.value.length);
}

/** Delete a tab, with an Undo button for a few seconds afterwards. Items are never touched. */
async function deleteTabWithUndo(root, stash, category) {
  const before = getStashConfig(stash);
  const wasActive = getActiveTab(stash.id) === category.id;
  if ( wasActive ) setActiveTab(stash.id, TAB_ALL);
  await saveTabs(stash, removeTab(before.categories, category.id));
  showSnackbar(root, {
    message: `Removed the "${category.name}" tab. Its items are in Unsorted.`,
    actionLabel: "Undo",
    accent: before.accent,
    onAction: async () => {
      // Items still remember their tab, so putting the tab back puts them back on it.
      await saveTabs(stash, before.categories);
      if ( wasActive ) setActiveTab(stash.id, category.id);
      stash.sheet?.render();
    }
  });
}

/** Right-click menu for a tab. */
function tabMenu(event, btn, root, stash, accent) {
  event.preventDefault();
  event.stopPropagation();
  closeFloating();
  const { categories } = getStashConfig(stash);
  const index = categories.findIndex(c => c.id === btn.dataset.tabId);
  const category = categories[index];
  if ( !category ) return;
  const count = stashCounts(stash)[category.id] ?? 0;

  const entries = [
    { icon: "fa-pen", label: "Rename", key: "F2", run: () => renameInline(btn, stash, category) },
    { icon: "fa-tags", label: "Keywords…", run: () => keywordsPopover(btn, stash, category, accent) },
    { divider: true },
    { icon: "fa-arrow-left", label: "Move left", disabled: index === 0,
      run: () => saveTabs(stash, moveTab(categories, category.id, -1)) },
    { icon: "fa-arrow-right", label: "Move right", disabled: index === categories.length - 1,
      run: () => saveTabs(stash, moveTab(categories, category.id, 1)) },
    { divider: true },
    { icon: "fa-trash", label: "Delete tab", key: "Del", danger: true, run: () => deleteTabWithUndo(root, stash, category) }
  ];

  const menu = document.createElement("div");
  menu.className = "ah-tab-menu";
  menu.setAttribute("role", "menu");
  menu.style.setProperty("--ah-accent", accent);
  menu.innerHTML = `<div class="ah-menu-head"><span class="ah-menu-dot"></span>${escapeHTML(category.name)}
      <span class="ah-menu-sub">${count} item${count === 1 ? "" : "s"}</span></div>`
    + entries.map((e, i) => (e.divider ? `<hr>` : `
    <button type="button" role="menuitem" data-i="${i}" class="${e.danger ? "ah-danger" : ""}" ${e.disabled ? "disabled" : ""}>
      <i class="fa-solid ${e.icon}"></i><span>${e.label}</span>${e.key ? `<kbd>${e.key}</kbd>` : ""}
    </button>`)).join("");
  menu.querySelectorAll("button[data-i]").forEach(b => b.addEventListener("click", () => {
    menu.remove();
    entries[Number(b.dataset.i)].run();
  }));
  placeFloating(menu, btn, event);
  closeOnOutside(menu);
  menu.querySelector("button:not([disabled])")?.focus();
  // Arrow keys move through the menu.
  menu.addEventListener("keydown", ev => {
    const items = [...menu.querySelectorAll("button:not([disabled])")];
    const i = items.indexOf(document.activeElement);
    if ( ev.key === "ArrowDown" ) { ev.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    if ( ev.key === "ArrowUp" ) { ev.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
  });
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

/** Last counts shown per stash, so a changed count can do a little "bump" animation. */
const lastCounts = new Map();

function addTabs(app, root, stash) {
  const oldNav = root.querySelector(".ah-stash-tabs");
  const oldScroll = oldNav?.scrollLeft ?? 0;
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

  const counts = stashCounts(stash);
  const previous = lastCounts.get(stash.id) ?? {};
  lastCounts.set(stash.id, counts);

  const tabs = [{ id: TAB_ALL, name: "All", icon: "fa-solid fa-layer-group" }];
  for ( const c of categories ) tabs.push({ id: c.id, name: c.name, keywords: c.keywords, custom: true });
  if ( categories.length ) tabs.push({ id: TAB_UNSORTED, name: "Unsorted", icon: "fa-solid fa-inbox" });

  const nav = document.createElement("nav");
  nav.className = "ah-stash-tabs";
  nav.setAttribute("role", "tablist");
  nav.setAttribute("aria-label", `${stash.name} tabs`);
  nav.innerHTML = tabs.map(t => {
    const tips = [];
    if ( t.id === TAB_ALL ) tips.push("Everything in this stash");
    if ( t.id === TAB_UNSORTED ) tips.push("Items not on any tab");
    if ( t.keywords?.length ) tips.push(`<strong>Keywords:</strong> ${t.keywords.map(escapeHTML).join(", ")}`);
    if ( t.custom && manage ) tips.push("<em>Double-click to rename · right-click for more · drag to reorder</em>");
    const isActive = t.id === active;
    const bumped = (t.id in previous) && (previous[t.id] !== counts[t.id]);
    return `<button type="button" role="tab" class="ah-stash-tab ${isActive ? "active" : ""}"
      data-tab-id="${escapeHTML(t.id)}" aria-selected="${isActive}" tabindex="${isActive ? 0 : -1}"
      ${t.custom && manage ? 'draggable="true"' : ""}
      ${tips.length ? `data-tooltip="${escapeHTML(tips.join("<br>"))}"` : ""}>
      ${t.icon ? `<i class="${t.icon}"></i>` : ""}<span class="ah-tab-name">${escapeHTML(t.name)}</span>
      <span class="ah-tab-count ${bumped ? "ah-bump" : ""}">${counts[t.id] ?? 0}</span>
    </button>`;
  }).join("") + (manage ? `<button type="button" class="ah-stash-tab ah-tab-add" tabindex="-1" data-tooltip="New tab" aria-label="New tab"><i class="fa-solid fa-plus"></i></button>` : "");

  const tabButtons = () => [...nav.querySelectorAll(".ah-stash-tab[data-tab-id]")];
  const activate = btn => {
    setActiveTab(stash.id, btn.dataset.tabId);
    for ( const b of tabButtons() ) {
      const on = b === btn;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
    }
    btn.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
    applyFilter(root, stash);
  };

  for ( const btn of tabButtons() ) {
    const tabId = btn.dataset.tabId;
    const category = categories.find(c => c.id === tabId);
    btn.addEventListener("click", event => {
      event.preventDefault();
      activate(btn);
    });

    // Your own tabs: double-click to rename, right-click for the menu, drag to reorder.
    if ( category && manage ) {
      btn.addEventListener("dblclick", event => {
        event.preventDefault();
        renameInline(btn, stash, category);
      });
      btn.addEventListener("contextmenu", event => tabMenu(event, btn, root, stash, accent));
      btn.addEventListener("dragstart", event => {
        event.stopPropagation();
        event.dataTransfer.setData(TAB_DRAG, tabId);
        event.dataTransfer.effectAllowed = "move";
        btn.classList.add("ah-dragging");
      });
      btn.addEventListener("dragend", () => {
        btn.classList.remove("ah-dragging");
        nav.querySelectorAll(".ah-drop-hover").forEach(b => b.classList.remove("ah-drop-hover"));
      });
    }

    // Drop an item on a tab to put it on that tab, or drop another tab here to reorder.
    btn.addEventListener("dragover", event => {
      const isTab = event.dataTransfer?.types?.includes(TAB_DRAG);
      if ( isTab && !category ) return; // tabs can only be dropped on other custom tabs
      event.preventDefault();
      event.stopPropagation();
      btn.classList.add("ah-drop-hover");
    });
    btn.addEventListener("dragleave", () => btn.classList.remove("ah-drop-hover"));
    btn.addEventListener("drop", async event => {
      event.preventDefault();
      event.stopPropagation();
      btn.classList.remove("ah-drop-hover");

      const movedTab = event.dataTransfer?.getData(TAB_DRAG);
      if ( movedTab ) {
        if ( category && (movedTab !== tabId) ) await saveTabs(stash, reorderTab(getStashConfig(stash).categories, movedTab, tabId));
        return;
      }

      const item = await droppedItem(event);
      if ( !item || isStash(item) || isProxy(item) ) return;
      // "All" and "Unsorted" mean "no tab". Dropping on "All" something already in this stash changes nothing.
      if ( (tabId === TAB_ALL) && (item.actor === stash.actor) && (item._source.system?.container === stash.id) ) return;
      const cat = ((tabId === TAB_ALL) || (tabId === TAB_UNSORTED)) ? null : tabId;
      await setItemCategory(item, stash, cat);
    });
  }

  // Keyboard: arrows/Home/End move between tabs, F2 renames, Delete removes (with Undo).
  nav.addEventListener("keydown", event => {
    const btn = event.target.closest?.(".ah-stash-tab[data-tab-id]");
    if ( !btn ) return;
    const list = tabButtons();
    const i = list.indexOf(btn);
    let next = null;
    if ( event.key === "ArrowRight" ) next = list[(i + 1) % list.length];
    else if ( event.key === "ArrowLeft" ) next = list[(i - 1 + list.length) % list.length];
    else if ( event.key === "Home" ) next = list[0];
    else if ( event.key === "End" ) next = list.at(-1);
    if ( next ) {
      event.preventDefault();
      event.stopPropagation();
      activate(next);
      next.focus();
      return;
    }
    const category = categories.find(c => c.id === btn.dataset.tabId);
    if ( !category || !manage ) return;
    if ( event.key === "F2" ) {
      event.preventDefault();
      event.stopPropagation();
      renameInline(btn, stash, category);
    } else if ( event.key === "Delete" ) {
      event.preventDefault();
      event.stopPropagation();
      deleteTabWithUndo(root, stash, category);
    }
  });

  // Mouse wheel scrolls the tab row sideways when there are more tabs than fit.
  nav.addEventListener("wheel", event => {
    if ( nav.scrollWidth <= nav.clientWidth ) return;
    if ( Math.abs(event.deltaY) <= Math.abs(event.deltaX) ) return;
    event.preventDefault();
    nav.scrollLeft += event.deltaY;
  }, { passive: false });

  // "+": a new tab appears right there, ready to type its name.
  const add = nav.querySelector(".ah-tab-add");
  add?.addEventListener("click", event => {
    event.preventDefault();
    if ( nav.querySelector(".ah-tab-editing") ) return nav.querySelector(".ah-tab-input")?.focus();
    closeFloating();
    const before = nav.querySelector(`.ah-stash-tab[data-tab-id="${TAB_UNSORTED}"]`) ?? add;
    const editor = inlineTabInput(before, {
      placeholder: "New tab name",
      onCommit: async name => {
        const id = foundry.utils.randomID(8);
        setActiveTab(stash.id, id);
        await saveTabs(stash, addTab(getStashConfig(stash).categories, name, id));
      }
    });
    editor.addEventListener("ah-cancel", () => {
      nav.querySelector(`.ah-stash-tab[data-tab-id="${getActiveTab(stash.id)}"]`)?.classList.add("active");
    });
  });

  inventory.before(nav);
  nav.scrollLeft = oldScroll;
  nav.querySelector(".ah-stash-tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
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
  addWrench(app, root);
  addTabs(app, root, stash);
}

/* -------------------------------------------- */
/*  Item right-click menus                      */
/* -------------------------------------------- */

/** Extra right-click options on items: move between tabs/stashes, or send to a stash from a character. */
function addItemContextOptions(item, options) {
  if ( !item || !Array.isArray(options) || isStash(item) || isProxy(item) || !isPhysical(item) || !item.isOwner ) return;
  const actor = item.actor;
  if ( !actor ) return;

  // Inside a stash window
  if ( isStashActor(actor) ) {
    const stash = getStash(item._source.system?.container);
    if ( !stash ) return;
    const { categories } = getStashConfig(stash);
    const current = item.getFlag(MODULE_ID, FLAGS.CATEGORY) ?? null;
    for ( const c of categories ) {
      if ( c.id === current ) continue;
      options.push({
        label: `Move to tab: ${plain(c.name)}`,
        icon: "fa-solid fa-folder-open",
        onClick: () => setItemCategory(item, stash, c.id)
      });
    }
    if ( current && categories.some(c => c.id === current) ) options.push({
      label: "Move to Unsorted",
      icon: "fa-solid fa-inbox",
      onClick: () => setItemCategory(item, stash, null)
    });
    for ( const other of getStashes() ) {
      if ( other.id === stash.id ) continue;
      options.push({
        label: `Move to stash: ${plain(other.name)}`,
        icon: "fa-solid fa-right-left",
        onClick: () => transferToStash(item, other, null)
      });
    }
    return;
  }

  // On a character: send it to any stash this character carries a bag for
  const seen = new Set();
  for ( const proxy of getProxies(actor) ) {
    const stash = stashForProxy(proxy);
    if ( !stash || seen.has(stash.id) ) continue;
    seen.add(stash.id);
    options.push({
      label: `Send to ${plain(stash.name)}`,
      icon: "fa-solid fa-box-archive",
      onClick: () => transferToStash(item, stash)
    });
  }
}

/* -------------------------------------------- */

export function registerUI() {
  Hooks.on("renderBaseActorSheet", decorateActorSheet);
  Hooks.on("renderContainerSheet", decorateStashSheet);
  Hooks.on("dnd5e.getItemContextOptions", addItemContextOptions);

  // Keep the overview window up to date.
  const refresh = item => { if ( isStash(item) || isProxy(item) ) refreshOverviews(); };
  Hooks.on("createItem", refresh);
  Hooks.on("updateItem", refresh);
  Hooks.on("deleteItem", refresh);

  // Changes to a stash's tabs or colour redraw open character sheets that carry its bag.
  Hooks.on("updateItem", item => {
    if ( !isStash(item) ) return;
    for ( const a of game.actors ) {
      if ( a.sheet?.rendered && getProxies(a).some(p => stashForProxy(p)?.id === item.id) ) a.sheet.render();
    }
  });

  // Items moving in or out of a stash update the count badge on characters' bags.
  const refreshCounts = item => {
    if ( !isStashActor(item?.actor) ) return;
    for ( const a of game.actors ) {
      if ( a.sheet?.rendered && getProxies(a).length ) decorateActorSheet(a.sheet, a.sheet.element);
    }
  };
  Hooks.on("createItem", refreshCounts);
  Hooks.on("deleteItem", refreshCounts);
  Hooks.on("updateItem", refreshCounts);
}
