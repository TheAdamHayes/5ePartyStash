import { MODULE_ID, SETTINGS, ICON_POOL, ICON_CHOICES, STASH_NAME, FOLDER_NAME } from "./constants.js";
import {
  ACCENT_SWATCHES, DEFAULT_ACCENT, TAB_ALL, TAB_UNSORTED, escapeHTML, isValidColor, layoutToText, moveEntry,
  parseKeywords, parseLayoutText, pickIcons
} from "./logic.js";
import {
  accessList, canManage, createStash, deleteStash, ensureStash, getPlayerCharacters, getStash, getStashActor,
  getStashConfig, getStashes, giveBag, giveToEveryone, openStash, stashCounts, takeBag, takeFromEveryone, updateStash
} from "./stash.js";

const { ApplicationV2, DialogV2 } = foundry.applications.api;

/** Open (or bring forward) the editor for a stash. */
export function openEditor(stash) {
  if ( !stash ) return null;
  if ( !canManage() ) {
    ui.notifications.warn(`${STASH_NAME}: only the GM can edit stashes in this world.`);
    return null;
  }
  const id = `ah-stash-editor-${stash.id}`;
  const existing = foundry.applications.instances.get(id);
  if ( existing ) {
    existing.bringToFront?.();
    return existing.render({ force: true });
  }
  return new StashEditor({ id, stashId: stash.id }).render({ force: true });
}

/** Re-draw any open overview windows (after a stash changes). */
let refreshTimer = null;
export function refreshOverviews() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    for ( const app of foundry.applications.instances.values() ) {
      if ( (app instanceof StashOverview) && app.rendered ) app.render();
    }
  }, 60);
}

/**
 * Size a window to its content, then make sure its bottom edge (where the Save button is) is on screen.
 * The window's own CSS caps its height at the screen height, and the middle part scrolls.
 */
function fitToScreen(app) {
  try {
    app.setPosition({ height: "auto" });
    const rect = app.element?.getBoundingClientRect();
    if ( !rect ) return;
    const margin = 10;
    const overflow = rect.bottom - (window.innerHeight - margin);
    if ( overflow > 0 ) app.setPosition({ top: Math.max(margin, rect.top - overflow) });
  } catch ( err ) {
    console.debug(`${MODULE_ID} | Could not resize window.`, err);
  }
}

/* -------------------------------------------- */
/*  Stash editor (the wrench)                   */
/* -------------------------------------------- */

export class StashEditor extends ApplicationV2 {
  constructor(options={}) {
    super(options);
    this.stashId = options.stashId;
    const stash = this.stash;
    const config = getStashConfig(stash);
    this.draft = {
      name: stash?.name ?? "",
      img: stash?.img ?? "",
      accent: config.accent,
      categories: config.categories.map(c => ({ id: c.id, name: c.name, keywords: c.keywords.join(", ") }))
    };
    this.dirty = false;
    this.focusAfterRender = null;
    this.iconChoices = this.#rollIcons();
  }

  static DEFAULT_OPTIONS = {
    tag: "form",
    classes: ["ah-party-stash-app", "ah-stash-editor"],
    window: { icon: "fa-solid fa-wrench", resizable: true },
    position: { width: 620, height: "auto" },
    form: { handler: StashEditor._onSubmit, submitOnChange: false, closeOnSubmit: true },
    actions: {
      reroll: StashEditor._onReroll,
      browse: StashEditor._onBrowse,
      pickSwatch: StashEditor._onPickSwatch,
      addTab: StashEditor._onAddTab,
      removeTab: StashEditor._onRemoveTab,
      moveTabUp: StashEditor._onMoveTabUp,
      moveTabDown: StashEditor._onMoveTabDown,
      pasteLayout: StashEditor._onPasteLayout,
      newStash: StashEditor._onNewStash,
      deleteStash: StashEditor._onDeleteStash
    }
  };

  get stash() {
    return getStash(this.stashId);
  }

  get title() {
    return `Edit Stash: ${this.stash?.name ?? ""}`;
  }

  /** Ten icons: the current one first, then nine random others. */
  #rollIcons() {
    const current = this.draft.img;
    const others = pickIcons(ICON_POOL, ICON_CHOICES - (current ? 1 : 0), current ? [current] : []);
    return current ? [current, ...others] : others;
  }

  /** Copy what's typed in the form into the draft, so nothing is lost when the window redraws. */
  #sync() {
    const form = this.element;
    if ( !form?.elements ) return;
    const el = form.elements;
    if ( el.name ) this.draft.name = el.name.value;
    if ( el.accent && isValidColor(el.accent.value) ) this.draft.accent = el.accent.value;
    const picked = form.querySelector('input[name="img"]:checked');
    if ( picked ) this.draft.img = picked.value;
    this.draft.categories = this.draft.categories.map((c, i) => ({
      id: c.id,
      name: el[`cat-name-${i}`]?.value ?? c.name,
      keywords: el[`cat-keywords-${i}`]?.value ?? c.keywords
    }));
  }

  /** Redraw, keeping the user's place. */
  #redraw(focus=null) {
    this.dirty = true;
    this.focusAfterRender = focus;
    this.render();
  }

  #addRowAfter(index) {
    this.#sync();
    const row = { id: foundry.utils.randomID(8), name: "", keywords: "" };
    this.draft.categories.splice(index + 1, 0, row);
    this.#redraw(`cat-name-${index + 1}`);
  }

  /** Enter in a tab name adds a tab below; Enter in keywords goes to the next tab; Ctrl+S saves. */
  #onKeydown(ev, content) {
    if ( (ev.ctrlKey || ev.metaKey) && (ev.key.toLowerCase() === "s") ) {
      ev.preventDefault();
      ev.stopPropagation();
      this.element.requestSubmit?.();
      return;
    }
    if ( ev.key !== "Enter" ) return;
    const name = ev.target.name ?? "";
    const m = name.match(/^cat-(name|keywords)-(\d+)$/);
    if ( !m ) return;
    ev.preventDefault();
    const i = Number(m[2]);
    if ( m[1] === "name" ) this.#addRowAfter(i);
    else {
      const next = content.querySelector(`input[name="cat-name-${i + 1}"]`);
      if ( next ) next.focus();
      else this.#addRowAfter(i);
    }
  }

  async _renderHTML() {
    const stash = this.stash;
    if ( !stash ) return `<p class="ah-hint">This stash no longer exists.</p>`;
    const d = this.draft;
    const canBrowse = game.user.can?.("FILES_BROWSE");
    const moreThanOne = getStashes().length > 1;
    const swatches = ACCENT_SWATCHES.includes(d.accent) ? ACCENT_SWATCHES : [...ACCENT_SWATCHES, d.accent];

    const icons = this.iconChoices.map((src, i) => `
      <label class="ah-icon-choice ${src === d.img ? "selected" : ""}" style="--i:${i}"
             data-tooltip="${escapeHTML(src.split("/").pop().replace(/\.webp$/, "").replace(/-/g, " "))}">
        <input type="radio" name="img" value="${escapeHTML(src)}" ${src === d.img ? "checked" : ""}>
        <img src="${escapeHTML(src)}" alt="">
      </label>`).join("");

    const rows = d.categories.map((c, i) => `
      <li class="ah-tab-row" data-index="${i}">
        <span class="ah-grip" draggable="true" data-tooltip="Drag to reorder"><i class="fa-solid fa-grip-vertical"></i></span>
        <input type="text" name="cat-name-${i}" value="${escapeHTML(c.name)}" placeholder="Tab name" maxlength="40">
        <input type="text" name="cat-keywords-${i}" value="${escapeHTML(c.keywords)}" placeholder="Keywords, separated, by, commas">
        <span class="ah-row-buttons">
          <button type="button" class="ah-icon-btn ah-ghost" data-action="moveTabUp" data-index="${i}" data-tooltip="Move up" ${i === 0 ? "disabled" : ""}><i class="fa-solid fa-chevron-up"></i></button>
          <button type="button" class="ah-icon-btn ah-ghost" data-action="moveTabDown" data-index="${i}" data-tooltip="Move down" ${i === d.categories.length - 1 ? "disabled" : ""}><i class="fa-solid fa-chevron-down"></i></button>
          <button type="button" class="ah-icon-btn ah-ghost ah-danger" data-action="removeTab" data-index="${i}" data-tooltip="Remove tab (its items move to Unsorted)"><i class="fa-solid fa-xmark"></i></button>
        </span>
      </li>`).join("");

    const previewTabs = [`<span class="ah-mini-tab active">All</span>`]
      .concat(d.categories.filter(c => c.name.trim()).map(c => `<span class="ah-mini-tab">${escapeHTML(c.name)}</span>`))
      .join("");

    return `
      <div class="ah-editor" style="--ah-accent: ${escapeHTML(d.accent)}">
       <div class="ah-editor-body">

        <section class="ah-preview">
          <div class="ah-preview-tile">
            <img class="ah-current-icon" src="${escapeHTML(d.img)}" alt="">
            <span class="ah-preview-label">${escapeHTML(d.name)}</span>
          </div>
          <div class="ah-preview-body">
            <input type="text" name="name" class="ah-name-input" value="${escapeHTML(d.name)}" placeholder="Stash name" required maxlength="60" aria-label="Stash name">
            <div class="ah-preview-tabs">${previewTabs}</div>
          </div>
        </section>

        <section class="ah-section">
          <header><h3><i class="fa-solid fa-palette"></i> Accent colour</h3></header>
          <div class="ah-swatches">
            ${swatches.map(c => `<button type="button" class="ah-swatch ${c === d.accent ? "selected" : ""}" data-action="pickSwatch" data-color="${c}" style="--sw:${c}" aria-label="Accent ${c}"></button>`).join("")}
            <label class="ah-swatch ah-swatch-custom" data-tooltip="Pick any colour">
              <input type="color" name="accent" value="${escapeHTML(d.accent)}">
              <i class="fa-solid fa-eye-dropper"></i>
            </label>
            <button type="button" class="ah-link" data-action="pickSwatch" data-color="${DEFAULT_ACCENT}">Reset</button>
          </div>
        </section>

        <section class="ah-section">
          <header>
            <h3><i class="fa-solid fa-image"></i> Icon</h3>
            <span class="ah-header-buttons">
              <button type="button" class="ah-pill" data-action="reroll"><i class="fa-solid fa-dice"></i> Reroll</button>
              ${canBrowse ? `<button type="button" class="ah-pill" data-action="browse"><i class="fa-solid fa-folder-open"></i> Browse…</button>` : ""}
            </span>
          </header>
          <div class="ah-icon-grid">${icons}</div>
        </section>

        <section class="ah-section">
          <header>
            <h3><i class="fa-solid fa-folder-tree"></i> Tabs</h3>
            <span class="ah-header-buttons">
              <button type="button" class="ah-pill" data-action="pasteLayout"><i class="fa-solid fa-paste"></i> Paste layout…</button>
            </span>
          </header>
          ${rows ? `<ol class="ah-tab-rows">${rows}</ol>` : `<p class="ah-hint ah-empty-tabs">No tabs yet. Everything shows under "All".</p>`}
          <button type="button" class="ah-add-row" data-action="addTab"><i class="fa-solid fa-plus"></i> Add tab</button>
          <p class="ah-hint"><kbd>Enter</kbd> in a tab name adds another tab. Keywords are saved with each tab, ready for automatic sorting in a future update.</p>
        </section>
       </div>

        <footer class="ah-footer">
          ${game.user.isGM && moreThanOne ? `<button type="button" class="ah-ghost ah-danger" data-action="deleteStash"><i class="fa-solid fa-trash"></i> Delete stash</button>` : ""}
          <span class="ah-spacer"></span>
          <button type="button" class="ah-ghost" data-action="newStash"><i class="fa-solid fa-box-open"></i> New stash</button>
          <button type="submit" class="ah-primary ${this.dirty ? "ah-dirty" : ""}" data-tooltip="Save (Ctrl+S)"><i class="fa-solid fa-floppy-disk"></i> Save</button>
        </footer>
      </div>`;
  }

  _replaceHTML(result, content) {
    const oldScroll = content.querySelector(".ah-editor-body")?.scrollTop ?? 0;
    content.innerHTML = result;
    const editor = content.querySelector(".ah-editor");
    if ( !editor ) return;
    const body = content.querySelector(".ah-editor-body");
    if ( body ) body.scrollTop = oldScroll;
    const markDirty = () => {
      this.dirty = true;
      content.querySelector('button[type="submit"]')?.classList.add("ah-dirty");
    };

    // Live preview: name, icon, colour and tab names update as you change them.
    const label = content.querySelector(".ah-preview-label");
    content.querySelector('input[name="name"]')?.addEventListener("input", ev => {
      if ( label ) label.textContent = ev.target.value;
      markDirty();
    });
    content.querySelectorAll('input[name="img"]').forEach(input => input.addEventListener("change", () => {
      content.querySelectorAll(".ah-icon-choice").forEach(l => l.classList.toggle("selected", l.contains(input) && input.checked));
      const preview = content.querySelector(".ah-current-icon");
      if ( preview ) {
        preview.src = input.value;
        preview.classList.remove("ah-pop");
        void preview.offsetWidth;
        preview.classList.add("ah-pop");
      }
      markDirty();
    }));
    content.querySelector('input[name="accent"]')?.addEventListener("input", ev => {
      editor.style.setProperty("--ah-accent", ev.target.value);
      content.querySelectorAll(".ah-swatch.selected").forEach(s => s.classList.remove("selected"));
      ev.target.closest(".ah-swatch")?.classList.add("selected");
      markDirty();
    });
    const previewTabs = content.querySelector(".ah-preview-tabs");
    const refreshPreviewTabs = () => {
      if ( !previewTabs ) return;
      const names = [...content.querySelectorAll('input[name^="cat-name-"]')].map(i => i.value.trim()).filter(Boolean);
      previewTabs.innerHTML = `<span class="ah-mini-tab active">All</span>`
        + names.map(n => `<span class="ah-mini-tab">${escapeHTML(n)}</span>`).join("");
    };
    content.querySelectorAll('input[name^="cat-"]').forEach(input => input.addEventListener("input", () => {
      refreshPreviewTabs();
      markDirty();
    }));

    // Keyboard: Enter in a tab name adds a tab below; Enter in keywords goes to the next tab; Ctrl+S saves.
    // (The window's content area stays the same between redraws, so this listener is only added once.)
    if ( !this._keysBound ) {
      this._keysBound = true;
      content.addEventListener("keydown", ev => this.#onKeydown(ev, content));
    }

    // Drag the grip to reorder tab rows.
    let dragFrom = null;
    content.querySelectorAll(".ah-tab-row").forEach(row => {
      const grip = row.querySelector(".ah-grip");
      grip?.addEventListener("dragstart", ev => {
        dragFrom = Number(row.dataset.index);
        ev.dataTransfer.setData("text/plain", "");
        ev.dataTransfer.effectAllowed = "move";
        try { ev.dataTransfer.setDragImage(row, 20, 16); } catch { /* not supported */ }
        row.classList.add("ah-dragging");
      });
      grip?.addEventListener("dragend", () => {
        row.classList.remove("ah-dragging");
        content.querySelectorAll(".ah-drop-above, .ah-drop-below").forEach(r => r.classList.remove("ah-drop-above", "ah-drop-below"));
      });
      row.addEventListener("dragover", ev => {
        if ( dragFrom === null ) return;
        ev.preventDefault();
        const below = ev.offsetY > (row.offsetHeight / 2);
        row.classList.toggle("ah-drop-below", below);
        row.classList.toggle("ah-drop-above", !below);
      });
      row.addEventListener("dragleave", () => row.classList.remove("ah-drop-above", "ah-drop-below"));
      row.addEventListener("drop", ev => {
        if ( dragFrom === null ) return;
        ev.preventDefault();
        ev.stopPropagation();
        const to = Number(row.dataset.index);
        const below = row.classList.contains("ah-drop-below");
        this.#sync();
        const list = [...this.draft.categories];
        const [moved] = list.splice(dragFrom, 1);
        let target = to + (below ? 1 : 0);
        if ( dragFrom < target ) target -= 1;
        list.splice(target, 0, moved);
        this.draft.categories = list;
        dragFrom = null;
        this.#redraw();
      });
    });

    // Put the cursor back where it should be.
    const focus = this.focusAfterRender ? content.querySelector(`[name="${this.focusAfterRender}"]`) : null;
    this.focusAfterRender = null;
    if ( focus ) {
      focus.focus();
      focus.select?.();
    } else if ( !this._focusedOnce ) {
      this._focusedOnce = true;
      content.querySelector('input[name="name"]')?.focus();
    }
  }

  /** After each redraw (e.g. a tab row added), grow or shrink the window to fit, but never past the screen. */
  _onRender(context, options) {
    super._onRender?.(context, options);
    if ( !options?.isFirstRender ) fitToScreen(this);
    // Keep the focused field in view inside the scrolling area.
    const active = this.element?.querySelector(".ah-editor-body :focus");
    active?.scrollIntoView?.({ block: "nearest" });
  }

  /* ---------- Actions ---------- */

  static async _onSubmit() {
    this.#sync();
    const stash = this.stash;
    if ( !stash ) return;
    const name = this.draft.name.trim() || stash.name;
    await updateStash(stash, {
      name,
      img: this.draft.img,
      accent: this.draft.accent,
      categories: this.draft.categories
        .filter(c => c.name.trim())
        .map(c => ({ id: c.id, name: c.name, keywords: parseKeywords(c.keywords) }))
    });
    this.dirty = false;
    ui.notifications.info(`${STASH_NAME}: saved "${name}".`);
  }

  static _onReroll(event, target) {
    this.#sync();
    this.iconChoices = this.#rollIcons();
    target.querySelector("i")?.classList.add("fa-spin");
    this.render();
  }

  static _onBrowse() {
    this.#sync();
    const FP = foundry.applications.apps.FilePicker.implementation;
    new FP({
      type: "image",
      current: this.draft.img,
      callback: path => {
        this.draft.img = path;
        this.iconChoices = [path, ...this.iconChoices.filter(p => p !== path)].slice(0, ICON_CHOICES);
        this.#redraw();
      }
    }).render({ force: true });
  }

  static _onPickSwatch(event, target) {
    const color = target.dataset.color;
    if ( !isValidColor(color) ) return;
    const input = this.element.querySelector('input[name="accent"]');
    if ( input ) input.value = color;
    this.draft.accent = color;
    this.element.querySelector(".ah-editor")?.style.setProperty("--ah-accent", color);
    this.element.querySelectorAll(".ah-swatch").forEach(s => s.classList.toggle("selected", s.dataset.color === color));
    this.dirty = true;
    this.element.querySelector('button[type="submit"]')?.classList.add("ah-dirty");
  }

  static _onAddTab() {
    this.#addRowAfter(this.draft.categories.length - 1);
  }

  static _onRemoveTab(event, target) {
    this.#sync();
    this.draft.categories.splice(Number(target.dataset.index), 1);
    this.#redraw();
  }

  static _onMoveTabUp(event, target) {
    this.#sync();
    const i = Number(target.dataset.index);
    this.draft.categories = moveEntry(this.draft.categories, i, -1);
    this.#redraw(`cat-name-${i - 1}`);
  }

  static _onMoveTabDown(event, target) {
    this.#sync();
    const i = Number(target.dataset.index);
    this.draft.categories = moveEntry(this.draft.categories, i, 1);
    this.#redraw(`cat-name-${i + 1}`);
  }

  static async _onPasteLayout() {
    this.#sync();
    const current = layoutToText({
      name: this.draft.name,
      categories: this.draft.categories.filter(c => c.name.trim()).map(c => ({ name: c.name, keywords: parseKeywords(c.keywords) }))
    });
    const text = await DialogV2.prompt({
      window: { title: "Paste Stash Layout", icon: "fa-solid fa-paste" },
      classes: ["ah-party-stash-app"],
      position: { width: 500 },
      content: `
        <p class="ah-hint">Write or paste a layout like this. <code>#</code> is the stash name, each <code>##</code>
        is a tab, and the line under it lists that tab's keywords.</p>
        <pre class="ah-example"># Bag Name\n## Category Name 1\n*Keywords, separated, by, commas*\n\n## Category Name 2\n*Keywords, separated, by, commas*</pre>
        <textarea name="layout" rows="12" class="ah-layout-text">${escapeHTML(current)}</textarea>`,
      ok: {
        label: "Apply",
        icon: "fa-solid fa-check",
        callback: (event, button) => button.form.elements.layout.value
      },
      rejectClose: false
    });
    if ( typeof text !== "string" ) return;
    const parsed = parseLayoutText(text);
    if ( parsed.name ) this.draft.name = parsed.name;
    // Keep each tab's id when its name matches an existing tab, so items stay on their tabs.
    const byName = new Map(this.draft.categories.map(c => [c.name.trim().toLowerCase(), c.id]));
    this.draft.categories = parsed.categories.map(c => ({
      id: byName.get(c.name.trim().toLowerCase()) ?? foundry.utils.randomID(8),
      name: c.name,
      keywords: c.keywords.join(", ")
    }));
    this.#redraw();
    ui.notifications.info(`${STASH_NAME}: layout applied. Press Save to keep it.`);
  }

  static async _onNewStash() {
    const stash = await createStash();
    if ( !stash ) return;
    openStash(stash);
    openEditor(stash);
  }

  static async _onDeleteStash() {
    const done = await deleteStash(this.stash);
    if ( done ) this.close();
  }
}

/* -------------------------------------------- */
/*  Overview (module settings menu, GM only)    */
/* -------------------------------------------- */

export class StashOverview extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "ah-stash-overview",
    classes: ["ah-party-stash-app", "ah-stash-overview"],
    window: { title: "Party Stash Overview", icon: "fa-solid fa-boxes-stacked", resizable: true },
    position: { width: 760, height: "auto" },
    actions: {
      open: StashOverview._onOpen,
      edit: StashOverview._onEdit,
      remove: StashOverview._onRemove,
      newStash: StashOverview._onNewStash,
      repair: StashOverview._onRepair,
      accessAll: StashOverview._onAccessAll,
      accessNone: StashOverview._onAccessNone,
      toggleAccess: StashOverview._onToggleAccess
    }
  };

  /** Stashes whose player list is folded away (remembered while Foundry is open). */
  static collapsed = new Set();

  async _renderHTML() {
    const actor = getStashActor();
    if ( !actor ) {
      return `<div class="ah-overview"><div class="ah-ov-empty">
          <i class="fa-solid fa-box-open"></i>
          <p>The stash hasn't been set up yet.</p>
          <button type="button" class="ah-primary" data-action="repair"><i class="fa-solid fa-screwdriver-wrench"></i> Set it up now</button>
        </div></div>`;
    }

    const stashes = getStashes();
    let totalItems = 0;
    const cards = stashes.map((s, idx) => {
      const config = getStashConfig(s);
      const counts = stashCounts(s);
      totalItems += counts[TAB_ALL];
      const access = accessList(s);
      const withAccess = access.filter(a => a.has);
      const collapsed = StashOverview.collapsed.has(s.id);
      const avatars = withAccess.slice(0, 5).map(a => `<img src="${escapeHTML(a.img)}" alt="" data-tooltip="${escapeHTML(a.actor.name)}">`).join("")
        + (withAccess.length > 5 ? `<span class="ah-avatar-more">+${withAccess.length - 5}</span>` : "");
      const rows = access.map(a => `
        <label class="ah-access-row ${a.has ? "on" : ""}" data-actor-id="${a.actor.id}">
          <input type="checkbox" class="ah-access-check" ${a.has ? "checked" : ""} aria-label="${escapeHTML(a.actor.name)} can use ${escapeHTML(s.name)}">
          <span class="ah-check"><i class="fa-solid fa-check"></i></span>
          <img class="ah-access-img" src="${escapeHTML(a.img)}" alt="">
          <span class="ah-access-name">
            <strong>${escapeHTML(a.actor.name)}</strong>
            <small>${a.owner ? escapeHTML(a.owner.name) : "No player"}</small>
          </span>
        </label>`).join("");
      const tabChips = config.categories.map(c => `<span class="ah-chip">${escapeHTML(c.name)} <b>${counts[c.id] ?? 0}</b></span>`).join("")
        + (config.categories.length && counts[TAB_UNSORTED] ? `<span class="ah-chip ah-chip-muted">Unsorted <b>${counts[TAB_UNSORTED]}</b></span>` : "");
      return `
        <article class="ah-card" data-stash-id="${s.id}" style="--ah-accent: ${escapeHTML(config.accent)}; --i:${idx}">
          <div class="ah-card-top">
            <button type="button" class="ah-card-icon" data-action="open" data-tooltip="Open stash">
              <img src="${escapeHTML(s.img)}" alt="">
            </button>
            <div class="ah-card-title">
              <h3>${escapeHTML(s.name)}${idx === 0 ? ` <span class="ah-badge" data-tooltip="Old bags that don't say which stash they open use this one">Main</span>` : ""}</h3>
              <span class="ah-card-sub">${counts[TAB_ALL]} item${counts[TAB_ALL] === 1 ? "" : "s"} · ${config.categories.length} tab${config.categories.length === 1 ? "" : "s"}</span>
            </div>
            <div class="ah-card-menu">
              <button type="button" class="ah-icon-btn ah-ghost" data-action="open" data-tooltip="Open stash"><i class="fa-solid fa-box-open"></i></button>
              <button type="button" class="ah-icon-btn ah-ghost" data-action="edit" data-tooltip="Edit stash"><i class="fa-solid fa-wrench"></i></button>
              <button type="button" class="ah-icon-btn ah-ghost ah-danger" data-action="remove" data-tooltip="${stashes.length < 2 ? "You can't delete the only stash" : "Delete stash"}" ${stashes.length < 2 ? "disabled" : ""}><i class="fa-solid fa-trash"></i></button>
            </div>
          </div>
          ${tabChips ? `<div class="ah-card-tabs">${tabChips}</div>` : ""}
          <section class="ah-access ${collapsed ? "collapsed" : ""}">
            <header class="ah-access-head">
              <button type="button" class="ah-access-toggle" data-action="toggleAccess" aria-expanded="${!collapsed}"
                      data-tooltip="${collapsed ? "Show" : "Hide"} who can use this stash">
                <i class="fa-solid fa-users"></i><span>Players</span>
                <span class="ah-avatars">${avatars}</span>
                <span class="ah-access-count">${withAccess.length}<span>/${access.length}</span></span>
                <i class="fa-solid fa-chevron-down ah-chevron"></i>
              </button>
              <span class="ah-access-quick">
                <button type="button" class="ah-link" data-action="accessAll" data-tooltip="Give every player character this stash's bag">All</button>
                <button type="button" class="ah-link" data-action="accessNone" data-tooltip="Take this stash's bag back from everyone (no items are lost)" ${withAccess.length ? "" : "disabled"}>None</button>
              </span>
            </header>
            <div class="ah-access-list">
              ${rows || `<p class="ah-hint">No player characters yet. A character shows here once a player owns it.</p>`}
            </div>
          </section>
        </article>`;
    }).join("");

    const players = !!game.settings.get(MODULE_ID, SETTINGS.PLAYERS_MANAGE);
    const give = !!game.settings.get(MODULE_ID, SETTINGS.AUTO_GIVE);
    const party = getPlayerCharacters().map(a => escapeHTML(a.name));
    return `
      <div class="ah-overview">
        <header class="ah-ov-head">
          <div>
            <h2>Party Stashes</h2>
            <span class="ah-card-sub">${stashes.length} stash${stashes.length === 1 ? "" : "es"} · ${totalItems} item${totalItems === 1 ? "" : "s"} in total</span>
          </div>
          <span class="ah-header-buttons">
            <button type="button" class="ah-pill" data-action="repair" data-tooltip="Re-creates missing sidebar items and updates every carried bag"><i class="fa-solid fa-screwdriver-wrench"></i> Repair &amp; re-sync</button>
            <button type="button" class="ah-primary" data-action="newStash"><i class="fa-solid fa-plus"></i> New stash</button>
          </span>
        </header>

        <div class="ah-ov-settings">
          <label class="ah-switch">
            <input type="checkbox" name="playersManage" ${players ? "checked" : ""}>
            <span class="ah-switch-track"></span>
            <span><strong>Players can create and edit stashes</strong>
            <small>When off, only GMs make stashes and change names, icons, colours and tabs. Everyone can always use stashes and sort items.</small></span>
          </label>
          <label class="ah-switch">
            <input type="checkbox" name="autoGive" ${give ? "checked" : ""}>
            <span class="ah-switch-track"></span>
            <span><strong>Give new stashes to every player character</strong>
            <small>${party.length ? `Player characters: ${party.join(", ")}` : "No player characters found yet (a character counts once a player owns it)."}</small></span>
          </label>
        </div>

        <div class="ah-ov-grid">${cards}</div>

        <p class="ah-hint ah-ov-foot"><i class="fa-solid fa-circle-info"></i> Each stash also has an item in the
        <strong>${FOLDER_NAME}</strong> folder of the Items sidebar. Drag it onto a character to give them that stash's bag.</p>
      </div>`;
  }

  _replaceHTML(result, content) {
    const scroll = content.scrollTop;
    content.innerHTML = result;
    content.scrollTop = scroll;
    content.querySelectorAll(".ah-access-check").forEach(input => {
      input.addEventListener("change", () => this.#onAccessChange(input));
    });
    content.querySelector('input[name="playersManage"]')?.addEventListener("change", ev => {
      game.settings.set(MODULE_ID, SETTINGS.PLAYERS_MANAGE, ev.target.checked);
    });
    content.querySelector('input[name="autoGive"]')?.addEventListener("change", ev => {
      game.settings.set(MODULE_ID, SETTINGS.AUTO_GIVE, ev.target.checked);
    });
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    if ( !options?.isFirstRender ) fitToScreen(this);
  }

  static #stashFrom(target) {
    return getStash(target.closest("[data-stash-id]")?.dataset.stashId);
  }

  static _onOpen(event, target) {
    openStash(StashOverview.#stashFrom(target));
  }

  static _onEdit(event, target) {
    openEditor(StashOverview.#stashFrom(target));
  }

  static async _onRemove(event, target) {
    await deleteStash(StashOverview.#stashFrom(target));
    this.render();
  }

  static async _onNewStash() {
    const stash = await createStash();
    if ( stash ) openEditor(stash);
    this.render();
  }

  static _onToggleAccess(event, target) {
    const stash = StashOverview.#stashFrom(target);
    if ( !stash ) return;
    const set = StashOverview.collapsed;
    const nowCollapsed = !set.has(stash.id);
    if ( nowCollapsed ) set.add(stash.id);
    else set.delete(stash.id);
    // Fold without redrawing the whole window
    const section = target.closest(".ah-access");
    section?.classList.toggle("collapsed", nowCollapsed);
    target.setAttribute("aria-expanded", String(!nowCollapsed));
  }

  static async _onAccessAll(event, target) {
    const stash = StashOverview.#stashFrom(target);
    if ( !stash ) return;
    if ( !getPlayerCharacters().length ) {
      ui.notifications.warn(`${STASH_NAME}: no player characters found. A character counts once a player owns it.`);
      return;
    }
    const given = await giveToEveryone(stash);
    ui.notifications.info(given.length
      ? `${STASH_NAME}: gave "${stash.name}" to ${given.join(", ")}.`
      : `${STASH_NAME}: every player character already has "${stash.name}".`);
    this.render();
  }

  static async _onAccessNone(event, target) {
    const stash = StashOverview.#stashFrom(target);
    if ( !stash ) return;
    const taken = await takeFromEveryone(stash);
    if ( taken.length ) ui.notifications.info(`${STASH_NAME}: took "${stash.name}" back from ${taken.join(", ")}. No items were lost.`);
    this.render();
  }

  /** Tick or untick one character's access. */
  async #onAccessChange(input) {
    const row = input.closest(".ah-access-row");
    const stash = StashOverview.#stashFrom(input);
    const actor = game.actors.get(row?.dataset.actorId);
    if ( !stash || !actor ) return;
    row.classList.toggle("on", input.checked);
    row.classList.add("ah-busy");
    input.disabled = true;
    try {
      if ( input.checked ) await giveBag(stash, actor);
      else await takeBag(stash, actor);
    } catch ( err ) {
      console.error(`${MODULE_ID} | Could not change access for ${actor.name}.`, err);
      ui.notifications.error(`${STASH_NAME}: couldn't change ${actor.name}'s access. See the console (F12).`);
      input.checked = !input.checked;
      row.classList.toggle("on", input.checked);
    } finally {
      row.classList.remove("ah-busy");
      input.disabled = false;
    }
  }

  static async _onRepair() {
    await ensureStash();
    ui.notifications.info(`${STASH_NAME}: all stashes checked and re-synced.`);
    this.render();
  }
}
