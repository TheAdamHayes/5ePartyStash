import { MODULE_ID, SETTINGS, ICON_POOL, ICON_CHOICES, STASH_NAME, FOLDER_NAME } from "./constants.js";
import {
  DEFAULT_ACCENT, escapeHTML, isValidColor, layoutToText, moveEntry, parseKeywords, parseLayoutText, pickIcons
} from "./logic.js";
import {
  getPlayerCharacters, giveToEveryone, takeFromEveryone, canManage, createStash, deleteStash, ensureStash, getStash, getStashActor, getStashConfig, getStashes,
  getProxies, isStashActor, openStash, stashForProxy, updateStash
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
  if ( existing ) return existing.render({ force: true });
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
    this.iconChoices = this.#rollIcons();
  }

  static DEFAULT_OPTIONS = {
    tag: "form",
    classes: ["ah-party-stash-app", "ah-stash-editor"],
    window: { icon: "fa-solid fa-wrench", resizable: true },
    position: { width: 600, height: "auto" },
    form: { handler: StashEditor._onSubmit, submitOnChange: false, closeOnSubmit: true },
    actions: {
      reroll: StashEditor._onReroll,
      browse: StashEditor._onBrowse,
      resetAccent: StashEditor._onResetAccent,
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

  async _renderHTML() {
    const stash = this.stash;
    if ( !stash ) return `<p class="ah-hint">This stash no longer exists.</p>`;
    const d = this.draft;
    const canBrowse = game.user.can?.("FILES_BROWSE");
    const moreThanOne = getStashes().length > 1;

    const icons = this.iconChoices.map(src => `
      <label class="ah-icon-choice ${src === d.img ? "selected" : ""}" data-tooltip="${escapeHTML(src.split("/").pop())}">
        <input type="radio" name="img" value="${escapeHTML(src)}" ${src === d.img ? "checked" : ""}>
        <img src="${escapeHTML(src)}" alt="">
      </label>`).join("");

    const rows = d.categories.map((c, i) => `
      <li class="ah-tab-row">
        <input type="text" name="cat-name-${i}" value="${escapeHTML(c.name)}" placeholder="Tab name">
        <input type="text" name="cat-keywords-${i}" value="${escapeHTML(c.keywords)}" placeholder="Keywords, separated, by, commas">
        <button type="button" class="ah-icon-btn" data-action="moveTabUp" data-index="${i}" data-tooltip="Move up" ${i === 0 ? "disabled" : ""}><i class="fa-solid fa-arrow-up"></i></button>
        <button type="button" class="ah-icon-btn" data-action="moveTabDown" data-index="${i}" data-tooltip="Move down" ${i === d.categories.length - 1 ? "disabled" : ""}><i class="fa-solid fa-arrow-down"></i></button>
        <button type="button" class="ah-icon-btn ah-danger" data-action="removeTab" data-index="${i}" data-tooltip="Remove tab (its items move to Unsorted)"><i class="fa-solid fa-trash"></i></button>
      </li>`).join("");

    return `
      <div class="ah-editor" style="--ah-accent: ${escapeHTML(d.accent)}">
        <section class="ah-editor-top">
          <img class="ah-current-icon" src="${escapeHTML(d.img)}" alt="">
          <div class="ah-editor-fields">
            <label class="ah-field"><span>Stash name</span>
              <input type="text" name="name" value="${escapeHTML(d.name)}" required>
            </label>
            <label class="ah-field"><span>Accent colour</span>
              <span class="ah-inline">
                <input type="color" name="accent" value="${escapeHTML(d.accent)}">
                <button type="button" data-action="resetAccent"><i class="fa-solid fa-rotate-left"></i> Default</button>
              </span>
            </label>
          </div>
        </section>

        <fieldset>
          <legend>Icon</legend>
          <div class="ah-icon-grid">${icons}</div>
          <div class="ah-inline">
            <button type="button" data-action="reroll"><i class="fa-solid fa-dice"></i> Reroll</button>
            ${canBrowse ? `<button type="button" data-action="browse"><i class="fa-solid fa-folder-open"></i> Browse…</button>` : ""}
          </div>
        </fieldset>

        <fieldset>
          <legend>Tabs</legend>
          <p class="ah-hint">Tabs appear at the top of this stash's window. Keywords are saved with each tab,
          ready for automatic sorting in a future update.</p>
          ${rows ? `<ol class="ah-tab-rows">${rows}</ol>` : `<p class="ah-hint"><em>No tabs yet. Everything shows under "All".</em></p>`}
          <div class="ah-inline">
            <button type="button" data-action="addTab"><i class="fa-solid fa-plus"></i> Add tab</button>
            <button type="button" data-action="pasteLayout"><i class="fa-solid fa-paste"></i> Paste layout…</button>
          </div>
        </fieldset>

        <footer class="ah-footer">
          <button type="submit" class="ah-primary"><i class="fa-solid fa-floppy-disk"></i> Save</button>
          <button type="button" data-action="newStash"><i class="fa-solid fa-box-open"></i> Create new stash</button>
          ${game.user.isGM && moreThanOne ? `<button type="button" class="ah-danger" data-action="deleteStash"><i class="fa-solid fa-trash"></i> Delete stash</button>` : ""}
        </footer>
      </div>`;
  }

  _replaceHTML(result, content) {
    content.innerHTML = result;
    // Show the picked icon straight away.
    content.querySelectorAll('input[name="img"]').forEach(input => input.addEventListener("change", () => {
      content.querySelectorAll(".ah-icon-choice").forEach(l => l.classList.toggle("selected", l.contains(input) && input.checked));
      const preview = content.querySelector(".ah-current-icon");
      if ( preview ) preview.src = input.value;
    }));
    content.querySelector('input[name="accent"]')?.addEventListener("input", ev => {
      content.querySelector(".ah-editor")?.style.setProperty("--ah-accent", ev.target.value);
    });
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
      categories: this.draft.categories.map(c => ({ id: c.id, name: c.name, keywords: parseKeywords(c.keywords) }))
    });
    ui.notifications.info(`${STASH_NAME}: saved "${name}".`);
  }

  static _onReroll() {
    this.#sync();
    this.iconChoices = this.#rollIcons();
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
        this.render();
      }
    }).render({ force: true });
  }

  static _onResetAccent() {
    this.#sync();
    this.draft.accent = DEFAULT_ACCENT;
    this.render();
  }

  static _onAddTab() {
    this.#sync();
    this.draft.categories.push({ id: foundry.utils.randomID(8), name: `Tab ${this.draft.categories.length + 1}`, keywords: "" });
    this.render();
  }

  static _onRemoveTab(event, target) {
    this.#sync();
    const i = Number(target.dataset.index);
    this.draft.categories.splice(i, 1);
    this.render();
  }

  static _onMoveTabUp(event, target) {
    this.#sync();
    this.draft.categories = moveEntry(this.draft.categories, Number(target.dataset.index), -1);
    this.render();
  }

  static _onMoveTabDown(event, target) {
    this.#sync();
    this.draft.categories = moveEntry(this.draft.categories, Number(target.dataset.index), 1);
    this.render();
  }

  static async _onPasteLayout() {
    this.#sync();
    const current = layoutToText({
      name: this.draft.name,
      categories: this.draft.categories.map(c => ({ name: c.name, keywords: parseKeywords(c.keywords) }))
    });
    const text = await DialogV2.prompt({
      window: { title: "Paste Stash Layout", icon: "fa-solid fa-paste" },
      position: { width: 480 },
      content: `
        <p class="ah-hint">Write or paste a layout like this. <code>#</code> is the stash name, each <code>##</code>
        is a tab, and the line under it lists that tab's keywords.</p>
        <pre class="ah-example"># Bag Name\n## Category Name 1\n*Keywords, separated, by, commas*\n\n## Category Name 2\n*Keywords, separated, by, commas*</pre>
        <textarea name="layout" rows="12" style="width:100%; font-family: monospace;">${escapeHTML(current)}</textarea>`,
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
    this.render();
    ui.notifications.info(`${STASH_NAME}: layout applied. Press Save to keep it.`);
  }

  static async _onNewStash() {
    const stash = await createStash();
    if ( !stash ) return;
    openStash(stash);
    openEditor(stash);
  }

  static async _onDeleteStash() {
    const stash = this.stash;
    const done = await deleteStash(stash);
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
    position: { width: 720, height: "auto" },
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
      return `<p class="ah-hint">The stash hasn't been set up yet. Press <strong>Repair</strong> to set it up now.</p>
        <footer class="ah-footer"><button type="button" data-action="repair"><i class="fa-solid fa-screwdriver-wrench"></i> Repair</button></footer>`;
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
    const rows = stashes.map((s, idx) => {
      const config = getStashConfig(s);
      const count = actor.items.filter(i => i._source.system?.container === s.id).length;
      const who = [...(carriers.get(s.id) ?? [])].sort();
      const tabs = config.categories.map(c => escapeHTML(c.name)).join(", ");
      return `
        <tr data-stash-id="${s.id}" style="--ah-accent: ${escapeHTML(config.accent)}">
          <td class="ah-ov-stash">
            <img src="${escapeHTML(s.img)}" alt="">
            <span class="ah-ov-name">${escapeHTML(s.name)}${idx === 0 ? ` <span class="ah-ov-main" data-tooltip="Old bags without a stash open this one">main</span>` : ""}</span>
          </td>
          <td class="ah-ov-num">${count}</td>
          <td>${tabs || "<em>None</em>"}</td>
          <td>${who.length ? who.map(escapeHTML).join(", ") : "<em>Nobody</em>"}</td>
          <td class="ah-ov-actions">
            <button type="button" class="ah-icon-btn" data-action="giveAll" data-tooltip="Give this stash's bag to every player character"><i class="fa-solid fa-user-plus"></i></button>
            <button type="button" class="ah-icon-btn" data-action="takeAll" data-tooltip="Take this stash's bag back from everyone (no items are lost)" ${who.length ? "" : "disabled"}><i class="fa-solid fa-user-minus"></i></button>
            <button type="button" class="ah-icon-btn" data-action="open" data-tooltip="Open stash"><i class="fa-solid fa-box-open"></i></button>
            <button type="button" class="ah-icon-btn" data-action="edit" data-tooltip="Edit stash"><i class="fa-solid fa-wrench"></i></button>
            <button type="button" class="ah-icon-btn ah-danger" data-action="remove" data-tooltip="Delete stash" ${stashes.length < 2 ? "disabled" : ""}><i class="fa-solid fa-trash"></i></button>
          </td>
        </tr>`;
    }).join("");

    const players = !!game.settings.get(MODULE_ID, SETTINGS.PLAYERS_MANAGE);
    const give = !!game.settings.get(MODULE_ID, SETTINGS.AUTO_GIVE);
    const party = getPlayerCharacters().map(a => escapeHTML(a.name)).join(", ");
    return `
      <div class="ah-overview">
        <label class="ah-ov-toggle">
          <input type="checkbox" name="playersManage" ${players ? "checked" : ""}>
          <span><strong>Players can create and edit stashes.</strong> When off, only GMs can make new stashes and change
          stash names, icons, colours and tabs. Everyone can still use the stashes and sort items between tabs.</span>
        </label>
        <label class="ah-ov-toggle">
          <input type="checkbox" name="autoGive" ${give ? "checked" : ""}>
          <span><strong>Give new stashes to every player character.</strong> A new stash's bag goes straight into
          their inventories. Player characters: ${party || "<em>none found (a character counts once a player owns it)</em>"}.</span>
        </label>
        <table class="ah-ov-table">
          <thead><tr><th>Stash</th><th>Items</th><th>Tabs</th><th>Carried by</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <p class="ah-hint">Each stash has an item in the <strong>${FOLDER_NAME}</strong> folder of the Items sidebar.
        Drag it onto a character to give them that stash's bag.</p>
        <footer class="ah-footer">
          <button type="button" class="ah-primary" data-action="newStash"><i class="fa-solid fa-plus"></i> New stash</button>
          <button type="button" data-action="repair" data-tooltip="Re-creates missing sidebar items and updates every carried bag"><i class="fa-solid fa-screwdriver-wrench"></i> Repair &amp; re-sync</button>
        </footer>
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
