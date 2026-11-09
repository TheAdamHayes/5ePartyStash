import { MODULE_ID, SETTINGS, ICON_POOL, ICON_CHOICES, STASH_NAME, FOLDER_NAME } from "./constants.js";
import {
  ACCENT_SWATCHES, DEFAULT_ACCENT, TAB_ALL, TAB_UNSORTED, escapeHTML, isValidColor, layoutToText, moveEntry,
  parseKeywords, parseLayoutText, pickIcons
} from "./logic.js";
import {
  canManage, createStash, deleteStash, ensureStash, getPlayerCharacters, getProxies, getStash, getStashActor,
  getStashConfig, getStashes, giveToEveryone, isStashActor, openStash, stashCounts, stashForProxy,
  takeFromEveryone, updateStash
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
export function refreshOverviews() {
  for ( const app of foundry.applications.instances.values() ) {
    if ( (app instanceof StashOverview) && app.rendered ) app.render();
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

        <footer class="ah-footer">
          ${game.user.isGM && moreThanOne ? `<button type="button" class="ah-ghost ah-danger" data-action="deleteStash"><i class="fa-solid fa-trash"></i> Delete stash</button>` : ""}
          <span class="ah-spacer"></span>
          <button type="button" class="ah-ghost" data-action="newStash"><i class="fa-solid fa-box-open"></i> New stash</button>
          <button type="submit" class="ah-primary ${this.dirty ? "ah-dirty" : ""}" data-tooltip="Save (Ctrl+S)"><i class="fa-solid fa-floppy-disk"></i> Save</button>
        </footer>
      </div>`;
  }

  _replaceHTML(result, content) {
    content.innerHTML = result;
    const editor = content.querySelector(".ah-editor");
    if ( !editor ) return;
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
      giveAll: StashOverview._onGiveAll,
      takeAll: StashOverview._onTakeAll
    }
  };

  async _renderHTML() {
    const actor = getStashActor();
    if ( !actor ) {
      return `<div class="ah-overview"><div class="ah-ov-empty">
          <i class="fa-solid fa-box-open"></i>
          <p>The stash hasn't been set up yet.</p>
          <button type="button" class="ah-primary" data-action="repair"><i class="fa-solid fa-screwdriver-wrench"></i> Set it up now</button>
        </div></div>`;
    }

    // Who carries which stash's bag
    const carriers = new Map();
    for ( const a of game.actors ) {
      if ( isStashActor(a) ) continue;
      for ( const p of getProxies(a) ) {
        const sid = stashForProxy(p)?.id;
        if ( !sid ) continue;
        if ( !carriers.has(sid) ) carriers.set(sid, new Set());
        carriers.get(sid).add(a.name);
      }
    }

    const stashes = getStashes();
    let totalItems = 0;
    const cards = stashes.map((s, idx) => {
      const config = getStashConfig(s);
      const counts = stashCounts(s);
      totalItems += counts[TAB_ALL];
      const who = [...(carriers.get(s.id) ?? [])].sort();
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
              <button type="button" class="ah-icon-btn ah-ghost" data-action="edit" data-tooltip="Edit stash"><i class="fa-solid fa-wrench"></i></button>
              <button type="button" class="ah-icon-btn ah-ghost ah-danger" data-action="remove" data-tooltip="${stashes.length < 2 ? "You can't delete the only stash" : "Delete stash"}" ${stashes.length < 2 ? "disabled" : ""}><i class="fa-solid fa-trash"></i></button>
            </div>
          </div>
          ${tabChips ? `<div class="ah-card-tabs">${tabChips}</div>` : ""}
          <div class="ah-card-carriers"><i class="fa-solid fa-users"></i>
            ${who.length ? who.map(n => `<span class="ah-person">${escapeHTML(n)}</span>`).join("") : `<em>Nobody carries this yet</em>`}
          </div>
          <footer class="ah-card-actions">
            <button type="button" class="ah-pill" data-action="giveAll"><i class="fa-solid fa-user-plus"></i> Give to everyone</button>
            <button type="button" class="ah-pill" data-action="takeAll" ${who.length ? "" : "disabled"}><i class="fa-solid fa-user-minus"></i> Take back</button>
            <button type="button" class="ah-pill ah-pill-accent" data-action="open"><i class="fa-solid fa-box-open"></i> Open</button>
          </footer>
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
    content.innerHTML = result;
    content.querySelector('input[name="playersManage"]')?.addEventListener("change", ev => {
      game.settings.set(MODULE_ID, SETTINGS.PLAYERS_MANAGE, ev.target.checked);
    });
    content.querySelector('input[name="autoGive"]')?.addEventListener("change", ev => {
      game.settings.set(MODULE_ID, SETTINGS.AUTO_GIVE, ev.target.checked);
    });
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

  static async _onGiveAll(event, target) {
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

  static async _onTakeAll(event, target) {
    const stash = StashOverview.#stashFrom(target);
    if ( !stash ) return;
    const yes = await DialogV2.confirm({
      window: { title: `Take back "${stash.name}"?`, icon: "fa-solid fa-user-minus" },
      content: `<p>Remove the <strong>${escapeHTML(stash.name)}</strong> bag from every character who carries it?</p>
        <p>No items are lost. Everything stays in the stash, and you can give the bags out again at any time.</p>`,
      yes: { label: "Take Back", icon: "fa-solid fa-user-minus" },
      no: { label: "Cancel", default: true },
      rejectClose: false
    });
    if ( !yes ) return;
    const taken = await takeFromEveryone(stash);
    ui.notifications.info(`${STASH_NAME}: took "${stash.name}" back from ${taken.length ? taken.join(", ") : "nobody"}.`);
    this.render();
  }

  static async _onRepair() {
    await ensureStash();
    ui.notifications.info(`${STASH_NAME}: all stashes checked and re-synced.`);
    this.render();
  }
}
